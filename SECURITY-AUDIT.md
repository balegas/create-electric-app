# Security Audit Report — Electric Agent Studio

**Date:** 2026-03-11
**Scope:** `packages/studio`, `packages/protocol`, `packages/agent`
**Auditor:** Multi-pass automated security analysis (Claude)

---

## Executive Summary

The Electric Agent Studio is a multi-agent orchestration platform where sandboxed AI agents (running in Fly.io Sprites or Docker) communicate via Durable Streams. The security model relies on:
- **Session tokens** (HMAC-SHA256) for per-session API authentication
- **Room tokens** (HMAC-SHA256) for room-scoped API authentication
- **Sandbox isolation** via Sprites VMs or Docker containers
- **Client-side credential storage** (keys passed per-request, not persisted server-side)
- **DS_SECRET proxy pattern** — the master Durable Streams secret never leaves the server process

### Fixes Applied Since Last Audit

Several critical and high issues from the previous audit have been **resolved**:

| Fix | Changeset | Status |
|-----|-----------|--------|
| Room auth middleware added | `room-auth-middleware.md` | **FIXED** — Room routes now validate `X-Room-Token` |
| `/api/hook` authentication added | `security-fixes-cmdinjection-hookauth.md` | **FIXED** — Global hook secret required |
| Command injection mitigated | `security-fixes-cmdinjection-hookauth.md` | **FIXED** — `validateName`, `validateBranchName`, `validateRepoUrl`, `shellQuote` |
| OAuth token logging removed | `security-fixes-cmdinjection-hookauth.md` | **FIXED** — Now only logs token length |
| DS_SECRET isolation | `ds-proxy-secret-isolation.md` | **FIXED** — `getStreamEnvVars` removed, proxy pattern added |
| Shared sessions removed | Code removal | **FIXED** — No shared-sessions endpoints remain |

This audit identifies **3 critical**, **4 high**, and **10 medium** severity issues that remain open or are newly discovered.

---

## Table of Contents

### Critical
1. [Single DS_SECRET = Cross-Room Stream Access at Durable Streams Layer](#1-critical-single-ds_secret--cross-room-stream-access-at-durable-streams-layer)
2. [Credentials Written to Sprite Filesystem in Plaintext](#2-critical-credentials-written-to-sprite-filesystem-in-plaintext)
3. [Unauthenticated Sandbox and Session-Creation Endpoints](#3-critical-unauthenticated-sandbox-and-session-creation-endpoints)

### High
4. [CORS `origin: "*"` on All Routes](#4-high-cors-origin--on-all-routes)
5. [XSS via `dangerouslySetInnerHTML`](#5-high-xss-via-dangerouslysetinnerhtml)
6. [Missing Input Validation on API Request Bodies](#6-high-missing-input-validation-on-api-request-bodies)
7. [Keychain Endpoint Leaks OAuth Token Without Auth](#7-high-keychain-endpoint-leaks-oauth-token-without-auth)

### Medium
8. [Room Token / Session Token Confusion](#8-medium-room-token--session-token-confusion)
9. [File Path Traversal Check Is Bypassable](#9-medium-file-path-traversal-check-is-bypassable)
10. [No Expiry on Session/Room Tokens](#10-medium-no-expiry-on-sessionroom-tokens)
11. [`/api/provision-electric` Is Unauthenticated](#11-medium-apiprovision-electric-is-unauthenticated)
12. [Room Message `from` Field Is Not Cryptographically Verified](#12-medium-room-message-from-field-is-not-cryptographically-verified)
13. [Missing HTTP Security Headers](#13-medium-missing-http-security-headers)
14. [Credentials Stored in localStorage (XSS Amplifier)](#14-medium-credentials-stored-in-localstorage-xss-amplifier)
15. [Sandbox Network Policy Allows All Outbound Traffic](#15-medium-sandbox-network-policy-allows-all-outbound-traffic)
16. [Docker Sandbox Missing Input Validation on Repo URL](#16-medium-docker-sandbox-missing-input-validation-on-repo-url)
17. [Session/Room Tokens Exposed in SSE Query Strings](#17-medium-sessionroom-tokens-exposed-in-sse-query-strings)

---

## Detailed Findings

### 1. CRITICAL: Single DS_SECRET = Cross-Room Stream Access at Durable Streams Layer

**File:** `packages/studio/src/streams.ts:43-80`

**Description:**
All Durable Stream connections (sessions, rooms, registry) use the **same `DS_SECRET`** for authorization:

```typescript
// Every stream uses identical auth header
headers: {
    Authorization: `Bearer ${config.secret}`,
}
```

The stream URL scheme is predictable:
- Session: `${url}/v1/stream/${serviceId}/session/${sessionId}`
- Room: `${url}/v1/stream/${serviceId}/room/${roomId}`
- Registry: `${url}/v1/stream/${serviceId}/registry`

**What changed:** The DS_SECRET is no longer passed to sandboxes as an env var (fix in `ds-proxy-secret-isolation.md`). Sandboxes use the `/api/sessions/:id/stream/append` proxy instead. This **significantly reduces** the attack surface.

**What remains:** The DS_SECRET is still a single master key. If it leaks from the server process (e.g., via error logging, memory dump, or a vulnerability in the server), it grants read/write access to ALL streams. There is no per-room or per-session scoping at the Durable Streams layer.

**Impact:** If the DS_SECRET is compromised, an attacker can:
1. Read any session's event stream (full conversation history)
2. Read any room's message stream
3. Write to any stream (inject fake events, forge messages)
4. Read the registry stream to enumerate all rooms

**Mitigating factor:** Since sandboxes no longer have the DS_SECRET, the primary risk vector is a compromise of the studio server itself.

**Recommendation:**
- Use Durable Streams' JWT support with scoped claims (limit each token to specific stream paths)
- Generate per-room/per-session JWTs with short TTLs
- Monitor for DS_SECRET rotation practices

**Severity: CRITICAL** (if DS_SECRET leaks, all isolation is broken)

---

### 2. CRITICAL: Credentials Written to Sprite Filesystem in Plaintext

**File:** `packages/studio/src/sandbox/sprites.ts:160-194`

**Description:**
API keys, OAuth tokens, and GitHub tokens are written as plaintext shell exports to the sandbox filesystem:

```typescript
if (opts?.oauthToken) {
    envVars.CLAUDE_CODE_OAUTH_TOKEN = opts.oauthToken
} else if (opts?.apiKey) {
    envVars.ANTHROPIC_API_KEY = opts.apiKey
}
if (opts?.ghToken) {
    envVars.GH_TOKEN = opts.ghToken
}

const envLines = Object.entries(envVars)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join("\n")
const b64 = Buffer.from(envLines).toString("base64")
await sprite.execFile("bash", [
    "-c",
    `echo ${b64} | base64 -d > /etc/profile.d/electric-agent.sh`,
])
```

**Impact:**
- The AI agent inside the sandbox has **full access** to these credentials
- If the agent is compromised via prompt injection, it can exfiltrate the API key and GitHub token
- The file `/etc/profile.d/electric-agent.sh` is world-readable by default
- Credentials persist for the lifetime of the Sprite VM

**User requirement: "the server never stores user credentials":**
- **Server process:** PASS — no persistent storage (DB or filesystem)
- **Server memory:** PARTIAL — credentials exist transiently during request handling
- **Sandbox filesystem:** FAIL — written as plaintext to `/etc/profile.d/electric-agent.sh`
- **Durable Streams:** PASS — credentials not written to event streams
- **Server logs:** PASS — only token length logged (previously fixed)

**Recommendation:**
1. **Credential proxy pattern** (best): Sandbox requests to Claude API / GitHub go through the studio server, which injects auth headers. Sandbox never holds raw keys.
2. **If direct credential access is unavoidable:**
   - Set file permissions to `0600` immediately after creation
   - Delete the file after the process reads it
   - Use environment-only injection (not files) if the sandbox runtime supports it

---

### 3. CRITICAL: Unauthenticated Sandbox and Session-Creation Endpoints

**File:** `packages/studio/src/server.ts:1725-1797, 905-960`

**Description:**
Several sensitive endpoints remain **unauthenticated**:

| Endpoint | Risk |
|---|---|
| `GET /api/sandboxes` | Lists all active sandboxes (session IDs, ports, project dirs) |
| `GET /api/sandboxes/:sessionId` | Reads sandbox details for any session |
| `POST /api/sandboxes` | Creates arbitrary sandboxes (resource consumption) |
| `DELETE /api/sandboxes/:sessionId` | Destroys any sandbox |
| `POST /api/sessions` | Creates sessions — accepts API keys in request body |
| `POST /api/sessions/resume` | Creates sessions from GitHub repos — accepts credentials |
| `POST /api/sessions/local` | Creates local sessions |
| `POST /api/sessions/auto` | Auto-creates sessions |
| `GET /api/sessions` | Lists all sessions (if endpoint exists) |

**Impact:**
- Any network-adjacent attacker can enumerate all sessions and sandboxes
- An attacker can create unlimited sandboxes (cost/resource abuse on Fly.io)
- An attacker can destroy other users' sandboxes
- Session creation endpoints accept API keys in the body with no auth — a confused deputy could be tricked into sending credentials

**Recommendation:**
- Add admin-level authentication to all `/api/sandboxes/*` routes
- Protect session creation with at minimum a server-level API key or OAuth
- Consider separate admin vs user authentication tiers

---

### 4. HIGH: CORS `origin: "*"` on All Routes

**File:** `packages/studio/src/server.ts:369`

```typescript
app.use("*", cors({ origin: "*" }))
```

**Impact:**
- Any website visited by a user can make API calls to the studio server
- Combined with `/api/credentials/keychain` (finding #7), a malicious site can steal OAuth tokens
- Combined with unauthenticated endpoints (finding #3), any site can create sessions or destroy sandboxes
- Enables cross-origin attacks on all mutation endpoints

**Recommendation:**
- Restrict CORS to the studio frontend's actual origin
- For development, use a configurable allowlist (e.g., `CORS_ORIGINS` env var)
- At minimum, restrict CORS on credential-returning endpoints

---

### 5. HIGH: XSS via `dangerouslySetInnerHTML`

**Files:** `packages/studio/client/src/components/Markdown.tsx:15`, `packages/studio/client/src/components/ToolExecution.tsx:62`

**Description:**
Both components render unsanitized HTML via `dangerouslySetInnerHTML`:

```typescript
// Markdown.tsx
const html = highlight(code)
return <code dangerouslySetInnerHTML={{ __html: html }} />

// ToolExecution.tsx
const html = highlight(content) + (truncated ? "\n... (truncated)" : "")
return <pre dangerouslySetInnerHTML={{ __html: html }} />
```

The `content` comes from agent output (tool responses, assistant messages). A compromised agent (via prompt injection) could emit code blocks containing crafted HTML/JS payloads.

**Impact:**
- If `sugar-high` has a parsing vulnerability or doesn't fully escape HTML entities, arbitrary JS execution is possible
- `ToolExecution.tsx` concatenates a raw string to the highlighted HTML
- Combined with finding #13 (localStorage credentials), XSS can steal API keys and OAuth tokens

**Recommendation:**
- Sanitize output with DOMPurify before setting innerHTML
- Or use a rendering approach that doesn't require `dangerouslySetInnerHTML`

---

### 6. HIGH: Missing Input Validation on API Request Bodies

**File:** `packages/studio/src/server.ts` (throughout)

**Description:**
Request bodies are cast to TypeScript interfaces but never validated at runtime:

```typescript
const body = (await c.req.json()) as {
    description: string
    apiKey?: string
    oauthToken?: string
    ghToken?: string
}
```

TypeScript type assertions provide **zero runtime protection**.

**Impact:**
- Wrong types, missing fields, oversized strings, or unexpected nested objects pass directly to business logic
- Could cause crashes, unexpected behavior, or edge case exploitation

**Recommendation:**
- Use Zod schemas (already a project dependency) to validate all API request bodies
- Return 400 errors for malformed payloads
- Set maximum string lengths for credential fields

---

### 7. HIGH: Keychain Endpoint Leaks OAuth Token Without Auth

**File:** `packages/studio/src/server.ts:2558-2579`

```typescript
app.get("/api/credentials/keychain", (c) => {
    if (process.platform !== "darwin") return c.json({ apiKey: null })
    // ... reads OAuth token from macOS Keychain and returns it in JSON
    return c.json({ oauthToken: token })
})
```

**Impact:**
- No authentication required
- Combined with CORS `origin: "*"`, **any website can steal the user's Claude Code OAuth token** by making a fetch request to `http://localhost:<port>/api/credentials/keychain`
- This is the single most exploitable vulnerability for credential theft on developer machines

**Recommendation:**
- Remove this endpoint in production builds
- For development, restrict to localhost-only requests (validate `Host` header)
- Add authentication even for development use

---

### 8. MEDIUM: Room Token / Session Token Confusion

**Files:** `packages/studio/src/server.ts:1817,1875`, `packages/studio/src/session-auth.ts:3-4`

**Description:**
Room tokens are derived using the **same function** as session tokens:

```typescript
// Room creation (server.ts:1875)
const roomToken = deriveSessionToken(config.streamConfig.secret, roomId)

// Room validation (server.ts:1817)
if (!token || !validateSessionToken(config.streamConfig.secret, id, token)) {
```

Both compute `HMAC-SHA256(DS_SECRET, id)` with no type prefix. This means:
- A session token for UUID `X` is **cryptographically identical** to a room token for UUID `X`
- If a room ID happens to collide with a session ID (both are UUIDs, so unlikely but not impossible), tokens are interchangeable

Compare with how hook tokens correctly use a prefix:
```typescript
// hook tokens — correctly scoped
return crypto.createHmac("sha256", secret).update(`hook:${sessionId}`).digest("hex")
```

**Impact:** Token confusion attack — a session token could potentially be used as a room token and vice versa. While UUID collision is unlikely, the lack of type differentiation is a design flaw that violates the principle of least privilege.

**Recommendation:**
Add a `room:` prefix to room token derivation:
```typescript
export function deriveRoomToken(secret: string, roomId: string): string {
    return crypto.createHmac("sha256", secret).update(`room:${roomId}`).digest("hex")
}
```

---

### 9. MEDIUM: File Path Traversal Check Is Bypassable

**File:** `packages/studio/src/server.ts:2510`

```typescript
if (!filePath.startsWith(sandboxDir)) {
    return c.json({ error: "Path outside project directory" }, 403)
}
```

**Impact:** If `sandboxDir = "/home/agent/workspace/myapp"`, then:
- `"/home/agent/workspace/myapp-evil/../../../etc/profile.d/electric-agent.sh"` passes the `startsWith` check
- This could expose credentials from the env file (finding #2)

**Recommendation:**
```typescript
const resolved = path.resolve(filePath)
if (!resolved.startsWith(path.resolve(sandboxDir) + path.sep)) {
    return c.json({ error: "Path outside project directory" }, 403)
}
```

---

### 10. MEDIUM: No Expiry on Session/Room Tokens

**File:** `packages/studio/src/session-auth.ts`

```typescript
export function deriveSessionToken(secret: string, sessionId: string): string {
    return crypto.createHmac("sha256", secret).update(sessionId).digest("hex")
}
```

**Impact:** Tokens are valid forever (or until DS_SECRET rotates). There is no revocation mechanism. A leaked session token provides permanent access to that session's data.

**Recommendation:**
- Include a timestamp in HMAC input and validate freshness (e.g., 24h TTL)
- Or migrate to JWTs with `exp` claim

---

### 11. MEDIUM: `/api/provision-electric` Is Unauthenticated

**File:** `packages/studio/src/server.ts:393-409`

**Impact:** Each call provisions real Electric Cloud infrastructure (database + sync service). An attacker can abuse this for resource exhaustion / cost generation.

**Recommendation:**
- Require authentication (session token or admin key)
- Add request throttling at minimum

---

### 12. MEDIUM: Room Message `from` Field Is Not Cryptographically Verified

**File:** `packages/studio/src/room-router.ts:152-163`

```typescript
async sendMessage(from: string, body: string, to?: string): Promise<void> {
    const event: RoomEvent = {
        type: "agent_message",
        from,          // Display name — not verified
        body,
        ts: ts(),
    }
    await this.stream.append(JSON.stringify(event))
}
```

**Impact:**
- The `POST /api/rooms/:id/messages` endpoint (now auth-protected by room token) accepts a `from` field that is a display name
- Any room member can send messages impersonating another participant
- The `from` field should either be server-enforced or cryptographically signed

**Mitigating factor:** Room token auth means only room members can send messages.

**Recommendation:**
- Server should look up the caller's identity and set `from` server-side instead of accepting it from the client

---

### 13. MEDIUM: Missing HTTP Security Headers

**File:** `packages/studio/src/server.ts`

The server does not set standard security headers:
- No `Content-Security-Policy` (critical for mitigating XSS from finding #5)
- No `X-Content-Type-Options: nosniff`
- No `X-Frame-Options: DENY`
- No `Strict-Transport-Security` (HSTS)

**Recommendation:**
- Add Hono middleware to set security headers on all responses

---

### 14. MEDIUM: Credentials Stored in localStorage (XSS Amplifier)

**File:** `packages/studio/client/src/lib/credentials.ts`

API keys and OAuth tokens stored at:
- `electric-agent:anthropic-api-key`
- `electric-agent:oauth-token`
- `electric-agent:gh-token`

**Impact:** Any XSS vulnerability (finding #5) can steal all stored credentials.

**Recommendation:**
- Consider `sessionStorage` (cleared on tab close)
- Implement strong CSP headers to mitigate XSS impact
- For production, use server-side sessions with httpOnly cookies

---

### 15. MEDIUM: Sandbox Network Policy Allows All Outbound Traffic

**File:** `packages/studio/src/sandbox/sprites.ts:96-111`

```typescript
private async setNetworkPolicyAllowAll(spriteName: string): Promise<void> {
    const resp = await fetch(url, {
        method: "POST",
        body: JSON.stringify({
            rules: [{ domain: "*", action: "allow" }],
        }),
    })
}
```

**Impact:**
- A compromised agent can make arbitrary outbound requests
- Can reach the studio server's internal API (enabling attacks on unauthenticated endpoints)
- Can exfiltrate data (credentials, code, conversation history) to any external server

**Recommendation:**
- Restrict outbound to only necessary domains: `api.anthropic.com`, `github.com`, `api.github.com`, `registry.npmjs.org`, etc.
- Block access to the studio server's internal IP/hostname from sandboxes
- Use a network-level firewall if the sandbox runtime supports it

---

### 16. MEDIUM: Docker Sandbox Missing Input Validation on Repo URL

**File:** `packages/studio/src/sandbox/docker.ts:510-535`

**Description:**
The Docker sandbox provider's `createFromRepo` method does **not** validate `repoUrl` or `branch` before constructing shell commands, unlike the Sprites provider which uses `validateRepoUrl()` and `validateBranchName()`:

```typescript
// docker.ts — NO validation
async createFromRepo(sessionId, repoUrl, opts) {
    execInContainer(state,
        `gh repo clone "${repoUrl}" "${targetDir}" 2>/dev/null || git clone "${repoUrl}" "${targetDir}"`)
}

// sprites.ts — HAS validation
async createFromRepo(sessionId, repoUrl, opts) {
    validateRepoUrl(repoUrl)       // ✓
    if (opts?.branch) validateBranchName(opts.branch)  // ✓
}
```

**Impact:** While the Docker provider uses double-quoted shell interpolation (providing some protection), a malicious `repoUrl` with shell metacharacters could still potentially escape the quoted context.

**Recommendation:**
- Apply the same `validateRepoUrl()` and `validateBranchName()` calls in the Docker provider
- Or better: validate at the server layer before dispatching to any sandbox provider

---

### 17. MEDIUM: Session/Room Tokens Exposed in SSE Query Strings

**Files:** `packages/studio/src/server.ts:2334,2255`, `docs/security.md:106`

**Description:**
The EventSource API (SSE) does not support custom headers. Session and room tokens are passed as query parameters:

```
GET /api/sessions/:id/events?token=<session-token>
GET /api/rooms/:id/events?token=<room-token>
```

**Impact:**
- Tokens appear in **server access logs** (nginx, CloudFlare, AWS ALB)
- Tokens may leak via **HTTP Referer headers** if users navigate away
- Tokens are visible in **browser history** and to **browser extensions**
- Load balancer and proxy logs retain the full URL including the token

**Mitigating factor:** This is a known limitation of the EventSource API. The `docs/security.md` acknowledges this design choice.

**Recommendation:**
- Use `fetch()` with streaming response and custom headers instead of `EventSource`
- If EventSource is required, use short-lived tokens specifically for SSE endpoints
- Ensure server/proxy logs redact query parameters containing tokens

---

## Positive Security Findings

The following security aspects are **well-implemented**:

| Aspect | Details |
|---|---|
| **Timing-safe token comparison** | `session-auth.ts` uses `crypto.timingSafeEqual()` — prevents timing attacks |
| **HMAC-SHA256 token derivation** | Stateless, deterministic, cryptographically sound |
| **Purpose-scoped tokens** | Session, hook, and global hook tokens use different HMAC prefixes — prevents token confusion |
| **Room token auth middleware** | Room routes now validate `X-Room-Token` header (fixed since last audit) |
| **DS_SECRET isolation** | Master secret no longer passes to sandboxes — proxy pattern enforced |
| **Global hook authentication** | `/api/hook` now requires `HMAC-SHA256(DS_SECRET, "global-hook")` |
| **Command injection prevention** | `validateName`, `validateBranchName`, `validateRepoUrl`, `shellQuote` functions |
| **No raw SQL** | Drizzle ORM prevents SQL injection in generated apps |
| **No `eval()` or `Function()`** | No dynamic code execution patterns |
| **Secure random generation** | `crypto.randomUUID()` and `crypto.randomBytes()` throughout |
| **Stream append proxy validation** | Content-Type, 64KB size limit, JSON validity enforced |
| **Session token on add-existing-session** | `POST /api/rooms/:id/sessions` requires both room token AND session token |

---

## Assessment Against User Requirements

### Requirement 1: "Sandbox cannot interfere with other sandboxes unless in the same room"

| Layer | Status | Details |
|---|---|---|
| VM isolation | **PASS** | Each sandbox runs in its own Sprites VM or Docker container |
| Session token auth | **PASS** | Session-scoped endpoints require HMAC tokens |
| Room token auth | **PASS** | Room-scoped endpoints require room tokens (newly fixed) |
| Sandbox → Studio API | **PARTIAL** | Sandbox could reach unauthenticated endpoints (finding #3, #14) |
| Stream-level isolation | **PARTIAL** | DS_SECRET no longer in sandboxes (fixed), but single master key at server layer (finding #1) |
| Network isolation | **FAIL** | `domain: "*"` allows sandbox to reach any endpoint including the studio server (finding #14) |

**Summary:** Room token auth is the primary improvement. The remaining gap is that sandboxes have unrestricted network access and several studio endpoints lack authentication. A compromised sandbox could reach unauthenticated sandbox/session-creation endpoints.

### Requirement 2: "Server never stores user credentials (Claude and GitHub keys)"

| Aspect | Status | Details |
|---|---|---|
| Database storage | **PASS** | No database stores credentials |
| Server filesystem | **PASS** | Server process doesn't write credentials to disk |
| Server memory | **PARTIAL** | Credentials exist transiently during request handling |
| Sandbox filesystem | **FAIL** | Written to `/etc/profile.d/electric-agent.sh` as plaintext |
| Server logs | **PASS** | Only logs token length (fixed) |
| Durable Streams | **PASS** | Credentials not in event streams |

**Summary:** The server process itself does not persistently store credentials. However, credentials ARE persisted inside sandbox VMs as plaintext files. Whether the sandbox counts as "the server" depends on your threat model — if the requirement means "the studio server Node.js process," it passes. If it means "the entire platform," it fails due to sandbox filesystem persistence.

### Requirement 3: "No agent can talk directly to another agent without being in the same room"

| Layer | Status | Details |
|---|---|---|
| Room router enforcement | **PASS** | `RoomRouter.deliverMessage()` only delivers to registered participants |
| Room API auth | **PASS** | Room endpoints now require room tokens (newly fixed) |
| Message integrity | **PARTIAL** | `from` field is a display name, not cryptographically verified (finding #11) |
| Session iterate | **PASS** | `POST /api/rooms/:id/sessions/:sessionId/iterate` requires room token |
| Direct stream access | **PASS** | Sandboxes no longer have DS_SECRET — can't write to room streams directly |

**Summary:** The room token middleware is the key fix. Agents can only communicate through rooms they have tokens for. The remaining gap is message impersonation within a room (finding #11).

---

## Priority Remediation Roadmap

### Phase 1 — Immediate (blocks production)
1. **Restrict CORS** — Replace `origin: "*"` with known origins (finding #4)
2. **Auth sandbox endpoints** — Add admin auth to all `/api/sandboxes/*` routes (finding #3)
3. **Fix XSS** — Sanitize `dangerouslySetInnerHTML` inputs with DOMPurify (finding #5)
4. **Remove/protect keychain endpoint** — Delete in production or add auth (finding #7)
5. **Fix path traversal** — Use `path.resolve()` for file-content endpoint (finding #8)
6. **Add input validation** — Zod schemas on all API request bodies (finding #6)

### Phase 2 — Before GA
7. **Credential proxy** — Route Claude/GitHub API calls through studio server so sandboxes never hold raw keys (finding #2)
8. **Restrict sandbox network** — Replace `domain: "*"` with allowlisted domains (finding #15)
9. **Server-side `from` enforcement** — Set message sender identity server-side (finding #12)
10. **Auth session creation** — Protect `POST /api/sessions` and `/api/sessions/resume` (finding #3)
11. **Auth `/api/provision-electric`** — Add auth or throttling (finding #11)
12. **Add security headers** — CSP, X-Content-Type-Options, X-Frame-Options, HSTS (finding #13)
13. **Scope room tokens** — Add `room:` prefix to room token HMAC to prevent token confusion (finding #8)
14. **Docker input validation** — Apply `validateRepoUrl`/`validateBranchName` in Docker provider (finding #16)

### Phase 3 — Hardening
15. **Scoped DS credentials** — Per-room/per-session JWTs at the Durable Streams layer (finding #1)
16. **Token expiry** — Add TTL to session/room tokens (finding #10)
17. **Audit logging** — Log security events (auth failures, room modifications, credential access)
18. **Replace localStorage** — Server-side session model with httpOnly cookies (finding #14)

---

## Appendix: Files Analyzed

### Studio Server
- `packages/studio/src/server.ts` — Main API server (2800+ lines)
- `packages/studio/src/session-auth.ts` — Token derivation and validation
- `packages/studio/src/streams.ts` — Durable Stream connection config
- `packages/studio/src/room-router.ts` — Agent-to-agent message routing
- `packages/studio/src/room-registry.ts` — Room metadata persistence
- `packages/studio/src/gate.ts` — Human-in-the-loop gating
- `packages/studio/src/invite-code.ts` — Room invite code generation

### Sandbox
- `packages/studio/src/sandbox/sprites.ts` — Fly.io Sprites sandbox provider
- `packages/studio/src/sandbox/docker.ts` — Docker sandbox provider
- `packages/studio/src/sandbox/types.ts` — Sandbox interface definitions

### Bridge
- `packages/studio/src/bridge/hosted.ts` — Hosted Durable Stream bridge
- `packages/studio/src/bridge/claude-code-sprites.ts` — Claude Code Sprites bridge
- `packages/studio/src/bridge/claude-code-docker.ts` — Claude Code Docker bridge
- `packages/studio/src/bridge/message-parser.ts` — Room message parsing

### Client
- `packages/studio/client/src/lib/credentials.ts` — localStorage credential storage
- `packages/studio/client/src/lib/api.ts` — API client with credential injection
- `packages/studio/client/src/components/Markdown.tsx` — Markdown rendering (XSS surface)
- `packages/studio/client/src/components/ToolExecution.tsx` — Tool output rendering (XSS surface)

### Protocol
- `packages/protocol/src/events.ts` — Event type definitions

### Agent
- `packages/agent/src/git/index.ts` — GitHub token handling in agent

### Documentation
- `docs/security.md` — Authentication architecture documentation
