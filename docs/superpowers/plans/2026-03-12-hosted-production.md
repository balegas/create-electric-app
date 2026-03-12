# Hosted Production Mode Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate the studio into Prod and Dev operating modes — Prod uses a server-side Claude API key, GitHub App for repo management, multi-layer rate limiting, and hides credential UI.

**Architecture:** The server already has a `devMode` flag (`config.devMode`). We extend this to gate credential fields, inject server-side API key, enforce global session caps, serve GitHub installation tokens on-demand, and install a git credential helper in Sprites. The UI uses the existing `/api/config` `devMode` flag to conditionally render credential fields.

**Tech Stack:** Node.js crypto (JWT signing), Hono (HTTP framework), GitHub App REST API, git credential helper (bash script)

**Spec:** `docs/superpowers/specs/2026-03-12-hosted-production-design.md`

---

## Chunk 1: Server Infrastructure

### Task 1: GitHub App Token Generator

**Files:**
- Create: `packages/studio/src/github-app.ts`
- Create: `packages/studio/src/github-app.test.ts`

This module generates GitHub App installation tokens using JWT + GitHub REST API.

- [ ] **Step 1: Write the test file**

```typescript
// packages/studio/src/github-app.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import crypto from "node:crypto"

// Generate a test RSA key pair
const { privateKey } = crypto.generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
})

describe("github-app", () => {
	describe("createGitHubAppJWT", () => {
		it("creates a valid JWT with correct claims", async () => {
			const { createGitHubAppJWT } = await import("./github-app.js")
			const jwt = createGitHubAppJWT("12345", privateKey)

			const parts = jwt.split(".")
			expect(parts).toHaveLength(3)

			const header = JSON.parse(
				Buffer.from(parts[0], "base64url").toString(),
			)
			expect(header).toEqual({ alg: "RS256", typ: "JWT" })

			const payload = JSON.parse(
				Buffer.from(parts[1], "base64url").toString(),
			)
			expect(payload.iss).toBe("12345")
			expect(payload.exp).toBeGreaterThan(payload.iat)
			expect(payload.exp - payload.iat).toBe(600) // 10 minutes
		})
	})

	describe("getInstallationToken", () => {
		it("exchanges JWT for installation token", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						token: "ghs_test123",
						expires_at: "2026-03-12T12:00:00Z",
					}),
			})
			vi.stubGlobal("fetch", mockFetch)

			const { getInstallationToken } = await import("./github-app.js")
			const result = await getInstallationToken(
				"12345",
				"67890",
				privateKey,
			)

			expect(result.token).toBe("ghs_test123")
			expect(result.expires_at).toBe("2026-03-12T12:00:00Z")

			const [url, opts] = mockFetch.mock.calls[0]
			expect(url).toBe(
				"https://api.github.com/app/installations/67890/access_tokens",
			)
			expect(opts.method).toBe("POST")
			expect(opts.headers.Accept).toBe(
				"application/vnd.github+json",
			)
			expect(opts.headers.Authorization).toMatch(/^Bearer ey/)

			const body = JSON.parse(opts.body)
			expect(body.permissions).toEqual({
				contents: "write",
				administration: "write",
			})

			vi.unstubAllGlobals()
		})

		it("throws on GitHub API error", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
				text: () => Promise.resolve("Bad credentials"),
			})
			vi.stubGlobal("fetch", mockFetch)

			const { getInstallationToken } = await import("./github-app.js")
			await expect(
				getInstallationToken("12345", "67890", privateKey),
			).rejects.toThrow("GitHub API error 401")

			vi.unstubAllGlobals()
		})
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/studio && npx vitest run src/github-app.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// packages/studio/src/github-app.ts
import crypto from "node:crypto"

export function createGitHubAppJWT(appId: string, privateKey: string): string {
	const now = Math.floor(Date.now() / 1000)
	const header = { alg: "RS256", typ: "JWT" }
	const payload = {
		iss: appId,
		iat: now - 60, // 60 seconds in the past for clock drift
		exp: now + 600, // 10 minutes
	}

	const enc = (obj: unknown) =>
		Buffer.from(JSON.stringify(obj)).toString("base64url")
	const unsigned = `${enc(header)}.${enc(payload)}`

	const sign = crypto.createSign("RSA-SHA256")
	sign.update(unsigned)
	const signature = sign.sign(privateKey, "base64url")

	return `${unsigned}.${signature}`
}

export async function getInstallationToken(
	appId: string,
	installationId: string,
	privateKey: string,
): Promise<{ token: string; expires_at: string }> {
	const jwt = createGitHubAppJWT(appId, privateKey)

	const response = await fetch(
		`https://api.github.com/app/installations/${installationId}/access_tokens`,
		{
			method: "POST",
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${jwt}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
			body: JSON.stringify({
				permissions: {
					contents: "write",
					administration: "write",
				},
			}),
		},
	)

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`GitHub API error ${response.status}: ${text}`)
	}

	const data = (await response.json()) as {
		token: string
		expires_at: string
	}
	return { token: data.token, expires_at: data.expires_at }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/studio && npx vitest run src/github-app.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/studio/src/github-app.ts packages/studio/src/github-app.test.ts
git commit -m "feat(studio): add GitHub App JWT and installation token generator"
```

---

### Task 2: Global Session Cap

**Files:**
- Modify: `packages/studio/src/server.ts` (lines 143-168, rate limiting section)

Add `MAX_TOTAL_SESSIONS` enforcement alongside existing per-IP rate limiting.

- [ ] **Step 1: Add MAX_TOTAL_SESSIONS constant and check function**

In `packages/studio/src/server.ts`, after the existing rate limiting constants (line 144), add the global session cap. Also add a check function that uses `config.sessions` (ActiveSessions) to count active sessions.

After line 144 (`const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000`), add:

```typescript
const MAX_TOTAL_SESSIONS = Number(
	process.env.MAX_TOTAL_SESSIONS || 50,
)
```

After the `checkSessionRateLimit` function (after line 168), add:

```typescript
function checkGlobalSessionCap(sessions: ActiveSessions): boolean {
	return sessions.size() >= MAX_TOTAL_SESSIONS
}
```

- [ ] **Step 2: Add `size()` method to ActiveSessions**

In `packages/studio/src/active-sessions.ts`, add a `size()` method to the class:

```typescript
size(): number {
	return this.sessions.size
}
```

Add after the existing `has()` method (after line 38).

- [ ] **Step 3: Enforce global cap in session creation endpoints**

In `packages/studio/src/server.ts`, in the `POST /api/sessions` handler (around line 972 where rate limiting is checked), add the global cap check right after the per-IP check:

Find the block that checks rate limiting (around line 972-978):
```typescript
if (!config.devMode) {
	const ip = extractClientIp(c)
	if (!checkSessionRateLimit(ip)) {
		return c.json({ error: "Rate limit exceeded" }, 429)
	}
}
```

After the rate limit check (but still inside the `!config.devMode` block), add:

```typescript
if (checkGlobalSessionCap(config.sessions)) {
	return c.json(
		{ error: "Service at capacity, please try again later" },
		503,
	)
}
```

Do the same in `POST /api/sessions/resume` (around line 2554) and `POST /api/rooms/:id/agents` (around line 1895 — add a new `!config.devMode` block if one doesn't exist).

- [ ] **Step 4: Run existing tests**

Run: `cd packages/studio && npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 5: Commit**

```bash
git add packages/studio/src/server.ts packages/studio/src/active-sessions.ts
git commit -m "feat(studio): add global session cap (MAX_TOTAL_SESSIONS)"
```

---

### Task 3: GitHub Token Endpoint

**Files:**
- Modify: `packages/studio/src/server.ts` — add `POST /api/sessions/:id/github-token` endpoint

This endpoint generates on-demand GitHub installation tokens for Sprite sandboxes.

- [ ] **Step 1: Add GitHub App config reading at server startup**

In `packages/studio/src/server.ts`, near the top where constants are defined (around line 143), add:

```typescript
const GITHUB_APP_ID = process.env.GITHUB_APP_ID
const GITHUB_INSTALLATION_ID = process.env.GITHUB_INSTALLATION_ID
const GITHUB_PRIVATE_KEY = process.env.GITHUB_PRIVATE_KEY?.replace(
	/\\n/g,
	"\n",
)
```

Add the import at the top of the file:

```typescript
import { getInstallationToken } from "./github-app.js"
```

- [ ] **Step 2: Add rate limiting for the token endpoint**

After the `sessionCreationsByIp` Map (around line 145), add:

```typescript
const githubTokenRequestsBySession = new Map<string, number[]>()
const MAX_GITHUB_TOKENS_PER_SESSION_PER_HOUR = 10

function checkGithubTokenRateLimit(sessionId: string): boolean {
	const now = Date.now()
	const requests = githubTokenRequestsBySession.get(sessionId) ?? []
	const recent = requests.filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
	if (recent.length >= MAX_GITHUB_TOKENS_PER_SESSION_PER_HOUR) {
		return false
	}
	recent.push(now)
	githubTokenRequestsBySession.set(sessionId, recent)
	return true
}
```

- [ ] **Step 3: Add the endpoint**

Add this endpoint near the other session endpoints (after `POST /api/sessions/:id/iterate`, around line 1432). It is already covered by the session auth middleware (lines 489-503).

```typescript
app.post("/api/sessions/:id/github-token", async (c) => {
	const sessionId = c.req.param("id")

	if (config.devMode) {
		return c.json({ error: "Not available in dev mode" }, 403)
	}

	if (!GITHUB_APP_ID || !GITHUB_INSTALLATION_ID || !GITHUB_PRIVATE_KEY) {
		return c.json({ error: "GitHub App not configured" }, 500)
	}

	if (!checkGithubTokenRateLimit(sessionId)) {
		return c.json({ error: "Too many token requests" }, 429)
	}

	try {
		const result = await getInstallationToken(
			GITHUB_APP_ID,
			GITHUB_INSTALLATION_ID,
			GITHUB_PRIVATE_KEY,
		)
		return c.json(result)
	} catch (err) {
		const message = err instanceof Error ? err.message : "Unknown error"
		console.error(`GitHub token error for session ${sessionId}:`, message)
		return c.json({ error: "Failed to generate GitHub token" }, 500)
	}
})
```

- [ ] **Step 4: Run existing tests**

Run: `cd packages/studio && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/studio/src/server.ts
git commit -m "feat(studio): add POST /api/sessions/:id/github-token endpoint"
```

---

### Task 4: Prod Mode Gating — Server-Side API Key and Endpoint Restrictions

**Files:**
- Modify: `packages/studio/src/server.ts` — session creation, resume, room agents

Note: `api-schemas.ts` needs no changes — `apiKey`, `oauthToken`, `ghToken` are already optional fields (`optionalKey`). The gating happens at the handler level, not the schema level.

- [ ] **Step 1: Inject server-side API key in POST /api/sessions**

In the `POST /api/sessions` handler (around line 962), after body validation, override credential fields in prod mode:

Find where `body` is validated (around line 963, using `validateBody(c, createSessionSchema)`). After the body validation, add:

```typescript
const apiKey = config.devMode ? body.apiKey : process.env.ANTHROPIC_API_KEY
const oauthToken = config.devMode ? body.oauthToken : undefined
const ghToken = config.devMode ? body.ghToken : undefined
```

Then update all references to `body.apiKey`, `body.oauthToken`, `body.ghToken` in this handler to use the local variables instead. Specifically:

- Around line 1132: Change `apiKey: body.apiKey` → `apiKey`
- Around line 1133: Change `oauthToken: body.oauthToken` → `oauthToken`
- Around line 1134: Change `ghToken: body.ghToken` → `ghToken`

Also in the GitHub accounts section (around line 1026-1036), wrap with devMode check:

```typescript
if (config.devMode && ghToken) {
	// existing ghListAccounts logic
}
```

- [ ] **Step 2: Block POST /api/sessions/resume in prod mode**

In the `POST /api/sessions/resume` handler (around line 2549), add at the top (before body parsing):

```typescript
if (!config.devMode) {
	return c.json({ error: "Resume from repo not available" }, 403)
}
```

- [ ] **Step 3: Gate POST /api/rooms/:id/agents in prod mode**

In the `POST /api/rooms/:id/agents` handler (around line 1895), after body validation:

```typescript
const apiKey = config.devMode ? body.apiKey : process.env.ANTHROPIC_API_KEY
const oauthToken = config.devMode ? body.oauthToken : undefined
const ghToken = config.devMode ? body.ghToken : undefined
```

Update the sandbox creation call (around line 1958-1960) to use these local variables.

Add rate limiting (per-IP + global cap) inside a `!config.devMode` block, same as the session creation endpoint.

- [ ] **Step 4: Gate GitHub API routes in prod mode**

For the GitHub routes (`GET /api/github/accounts`, `GET /api/github/repos`, `GET /api/github/repos/:owner/:repo/branches`), add at the start of each handler:

```typescript
if (!config.devMode) {
	return c.json({ error: "Not available" }, 403)
}
```

- [ ] **Step 5: Run existing tests**

Run: `cd packages/studio && npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/studio/src/server.ts
git commit -m "feat(studio): gate credentials and endpoints behind devMode for prod"
```

---

## Chunk 2: Sandbox & UI Changes

### Task 5: Git Credential Helper in Sprites

**Files:**
- Modify: `packages/studio/src/sandbox/sprites.ts` (lines 134-219, create method)

Install a custom git credential helper that fetches GitHub tokens from the studio server, replacing the default `gh auth git-credential` helper in prod mode.

- [ ] **Step 1: Add credential helper setup method**

In `packages/studio/src/sandbox/sprites.ts`, add a private method to the `SpritesSandboxProvider` class (after the `create` method):

```typescript
private async installCredentialHelper(
	sprite: Sprite,
	sessionId: string,
	sessionToken: string,
	studioUrl: string,
): Promise<void> {
	const script = `#!/bin/bash
# git-credential-electric: fetches GitHub tokens from studio server
if [ "$1" != "get" ]; then exit 0; fi

input=$(cat)
host=$(echo "$input" | grep "^host=" | cut -d= -f2)
if [ "$host" != "github.com" ]; then exit 0; fi

response=$(curl -s -w "\\n%{http_code}" -X POST \\
  -H "Authorization: Bearer \${SESSION_TOKEN}" \\
  "\${STUDIO_URL}/api/sessions/\${SESSION_ID}/github-token")

http_code=$(echo "$response" | tail -1)
body=$(echo "$response" | sed '\\$d')

if [ "$http_code" != "200" ]; then
  echo "git-credential-electric: failed to fetch token (HTTP $http_code)" >&2
  exit 1
fi

token=$(echo "$body" | jq -r '.token')
if [ -n "$token" ] && [ "$token" != "null" ]; then
  echo "protocol=https"
  echo "host=github.com"
  echo "username=x-access-token"
  echo "password=\${token}"
else
  echo "git-credential-electric: invalid token response" >&2
  exit 1
fi`

	const encoded = Buffer.from(script).toString("base64")
	// NOTE: sprite.exec() splits by whitespace — use execFile with bash -c for shell features
	await sprite.execFile("bash", [
		"-c",
		`echo "${encoded}" | base64 -d > /usr/local/bin/git-credential-electric && chmod +x /usr/local/bin/git-credential-electric`,
	])

	// Add session env vars for credential helper
	const envScript = [
		`export SESSION_TOKEN="${sessionToken}"`,
		`export SESSION_ID="${sessionId}"`,
		`export STUDIO_URL="${studioUrl}"`,
	].join("\n")
	const envEncoded = Buffer.from(envScript).toString("base64")
	await sprite.execFile("bash", [
		"-c",
		`echo "${envEncoded}" | base64 -d >> /etc/profile.d/electric-agent.sh`,
	])

	// Override the default gh credential helper
	await sprite.execFile("git", [
		"config",
		"--global",
		"credential.helper",
		"electric",
	])
}
```

- [ ] **Step 2: Call credential helper setup in create() for prod mode**

In `packages/studio/src/sandbox/sprites.ts`, the `create()` method needs access to `devMode`, `sessionToken`, and `studioUrl`. These must be passed via `CreateSandboxOpts`.

In `packages/studio/src/sandbox/types.ts`, add the `prodMode` field to the existing `CreateSandboxOpts` interface (around line 55-61):

```typescript
// Add this field to the existing interface:
prodMode?: {
	sessionToken: string
	studioUrl: string
}
```

Then in `sprites.ts` `create()`, after the env vars are written (after line 194, the base64 env write), add:

```typescript
if (opts?.prodMode) {
	await this.installCredentialHelper(
		sprite,
		sessionId,
		opts.prodMode.sessionToken,
		opts.prodMode.studioUrl,
	)
}
```

- [ ] **Step 3: Pass prodMode opts from server.ts**

In `packages/studio/src/server.ts`, where `sandbox.create()` is called in `POST /api/sessions` (around line 1129-1152), add the `prodMode` field when not in dev mode:

```typescript
const sandboxOpts: CreateSandboxOpts = {
	apiKey,
	oauthToken,
	ghToken,
	projectName: session.projectName,
	infra,
	...(!config.devMode && {
		prodMode: {
			sessionToken: deriveSessionToken(
				config.streamConfig.secret,
				sessionId,
			),
			studioUrl: resolveStudioUrl(config.port),
		},
	}),
}
```

Import `deriveSessionToken` and `resolveStudioUrl` if not already imported.

Do the same for `POST /api/rooms/:id/agents` sandbox creation (around line 1955-1961).

- [ ] **Step 4: Run existing tests**

Run: `cd packages/studio && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/studio/src/sandbox/sprites.ts packages/studio/src/sandbox/types.ts packages/studio/src/server.ts
git commit -m "feat(studio): install git credential helper in Sprites for prod mode"
```

---

### Task 6: UI Changes — Hide Credentials in Prod Mode

**Files:**
- Modify: `packages/studio/client/src/components/Settings.tsx`
- Modify: `packages/studio/client/src/pages/HomePage.tsx`
- Modify: `packages/studio/client/src/lib/api.ts`

- [ ] **Step 1: Pass devMode to Settings component**

In `packages/studio/client/src/layouts/AppShell.tsx`, the `devMode` state already exists (line 62). It's passed to child components. Check that `Settings` receives `devMode` as a prop. If not, add it.

In `Settings.tsx`, accept `devMode` prop and wrap credential sections:

```tsx
// Wrap the Claude Authentication section (lines 119-177) with:
{devMode && (
	// ... existing Claude auth section
)}

// Wrap the GitHub PAT section (lines 180-224) with:
{devMode && (
	// ... existing GitHub token section
)}
```

- [ ] **Step 2: Hide "Resume from GitHub" button in prod mode**

In `packages/studio/client/src/pages/HomePage.tsx`, the "Resume from GitHub" button (lines 114-123) is currently gated by `hasGhToken`. Add `devMode` check:

The HomePage needs access to `devMode`. If it doesn't already receive it, pass it from the router/layout.

```tsx
// Change from:
{hasGhToken && (
	// Resume from GitHub button
)}

// To:
{devMode && hasGhToken && (
	// Resume from GitHub button
)}
```

- [ ] **Step 3: Stop sending credentials in prod mode**

In `packages/studio/client/src/lib/api.ts`, modify `credentialFields()` (lines 8-17) to check devMode:

```typescript
let _devMode = false // default: don't send credentials until config confirms dev mode

export function setDevMode(mode: boolean) {
	_devMode = mode
}

function credentialFields() {
	if (!_devMode) return {}
	// ... existing credential extraction logic
}
```

Call `setDevMode(cfg.devMode)` in `AppShell.tsx` where `fetchConfig()` result is handled (line 165).

- [ ] **Step 4: Skip keychain auto-fetch in prod mode**

In `packages/studio/client/src/layouts/AppShell.tsx`, the keychain fetch (lines 140-152) should be gated:

```typescript
// Wrap keychain fetch with devMode check
if (devMode) {
	// existing keychain fetch logic
}
```

Since `devMode` state is set asynchronously, ensure the keychain fetch happens after config is loaded.

- [ ] **Step 5: Verify build passes**

Run: `cd packages/studio && npm run build`
Expected: Build succeeds with no type errors

- [ ] **Step 6: Commit**

```bash
git add packages/studio/client/src/components/Settings.tsx packages/studio/client/src/pages/HomePage.tsx packages/studio/client/src/lib/api.ts packages/studio/client/src/layouts/AppShell.tsx
git commit -m "feat(studio): hide credential UI in prod mode"
```

---

### Task 6b: Session Cost Display in UI

**Files:**
- Modify: `packages/studio/client/src/pages/SessionPage.tsx`

The session cost is already tracked server-side (`SessionInfo.totalCostUsd`) and displayed in the session header (lines 232-236). However, it needs to show the budget limit alongside the current spend so users understand their remaining budget.

- [ ] **Step 1: Add budget display alongside cost**

In `packages/studio/client/src/pages/SessionPage.tsx`, find the cost badge display (around lines 232-236). Update it to show the budget limit in prod mode:

```tsx
// Current: ${cost.totalCostUsd.toFixed(2)}
// Change to show budget: ${cost.totalCostUsd.toFixed(2)} / $${maxBudget}
```

The `maxBudget` value should come from the server. Add it to the `/api/config` response:

In `packages/studio/src/server.ts`, update the `GET /api/config` endpoint (around line 445-447) to include budget info:

```typescript
app.get("/api/config", (c) => {
	return c.json({
		devMode: config.devMode,
		maxSessionCostUsd: config.devMode ? undefined : MAX_SESSION_COST_USD,
	})
})
```

In the client, update `fetchConfig()` return type and pass `maxSessionCostUsd` to SessionPage.

- [ ] **Step 2: Verify cost events are being emitted and processed**

Check that `accumulateSessionCost` (server.ts lines 181-225) is properly emitting cost updates to the SSE stream. The `useSession` hook (lines 183-193) accumulates `session_end` events — verify these events include `cost_usd`. If cost events aren't reaching the client, add a `session_cost` event emission after accumulation.

- [ ] **Step 3: Verify build passes**

Run: `cd packages/studio && npm run build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add packages/studio/client/src/pages/SessionPage.tsx packages/studio/client/src/lib/api.ts packages/studio/src/server.ts
git commit -m "feat(studio): display session cost with budget limit in prod mode"
```

---

### Task 6c: Repo Naming and Publish Gate

**Files:**
- Modify: Agent system prompt / create-app skill to include publish gate instructions

The repo naming (`electric-apps/electric-<name>`) and publish gate (agent asks user at end of plan) are enforced through agent instructions, not application code. The git credential helper (Task 5) handles authentication; the agent uses `gh` CLI for repo creation.

- [ ] **Step 1: Add publish gate instructions to agent prompt**

In `packages/studio/src/server.ts`, find where the CLAUDE.md content is written to the sandbox (around lines 1213-1239). In prod mode, append publish gate instructions:

```typescript
if (!config.devMode) {
	claudeMdContent += `\n\n## GitHub Publishing (Prod Mode)\n
After the first complete iteration of the plan (all code generated, build passing, tests passing):
1. Ask the user: "Your app is ready! Would you like me to publish it to GitHub?"
2. If yes, create the repo and push:
   - gh repo create electric-apps/electric-<project-name> --public --source=. --push
   - If the name is taken, append a short hash: electric-<name>-<4char-hash>
   - Share the repo URL with the user
3. If no, skip publishing — the code stays in the sandbox only.

The git credential helper is pre-configured. No GitHub token setup needed.\n`
}
```

- [ ] **Step 2: Add repo name sanitization helper**

The agent will use `gh repo create` with the project name. The name sanitization (lowercase, hyphens, no special chars) should be documented in the agent instructions. Add to the publish section above:

```
Project name sanitization rules:
- Convert to lowercase
- Replace spaces and underscores with hyphens
- Remove special characters except hyphens
- Prefix with "electric-"
```

- [ ] **Step 3: Commit**

```bash
git add packages/studio/src/server.ts
git commit -m "feat(studio): add publish gate instructions for prod mode agent"
```

---

## Chunk 3: Documentation & Deployment Config

### Task 7: Update Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `fly.toml`

- [ ] **Step 1: Update fly.toml with new env var placeholders**

In `fly.toml`, add to the `[env]` section:

```toml
[env]
  NODE_ENV = "production"
  PORT = "8080"
  SANDBOX_RUNTIME = "sprites"
  MAX_TOTAL_SESSIONS = "50"
  MAX_SESSIONS_PER_IP_PER_HOUR = "5"
  MAX_SESSION_COST_USD = "5"
```

Note: `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY` are set as Fly secrets, not env vars.

- [ ] **Step 2: Update CLAUDE.md**

Add a section documenting the two operating modes and new environment variables. Add after the "## Infrastructure" section:

```markdown
## Operating Modes

### Prod Mode (NODE_ENV=production, STUDIO_DEV_MODE unset)
- Claude API key: pre-configured via ANTHROPIC_API_KEY env var on server
- GitHub: repos created in `electric-apps` org via GitHub App
- Rate limiting: MAX_TOTAL_SESSIONS + MAX_SESSIONS_PER_IP_PER_HOUR + MAX_SESSION_COST_USD
- UI: no credential fields, no "Start from repo"
- POST /api/sessions/resume: returns 403

### Dev Mode (STUDIO_DEV_MODE=1)
- User provides own Claude API key and GitHub token
- Full UI with all credential fields
- No rate limiting
- Can start from existing repos

### Environment Variables (Prod)
| Variable | Description | Default |
|----------|-------------|---------|
| MAX_TOTAL_SESSIONS | Max concurrent active sessions | 50 |
| MAX_SESSIONS_PER_IP_PER_HOUR | Per-IP session rate limit | 5 |
| MAX_SESSION_COST_USD | Per-session cost budget | 5 |

### Fly Secrets (Prod — GitHub App)
| Secret | Description |
|--------|-------------|
| GITHUB_APP_ID | GitHub App numeric ID |
| GITHUB_INSTALLATION_ID | Installation ID for electric-apps org |
| GITHUB_PRIVATE_KEY | PEM private key (replace \\n with actual newlines) |
```

- [ ] **Step 3: Update README.md**

Read the existing `README.md` and add a section documenting:
- The two operating modes (prod vs dev)
- How to run locally in dev mode (`STUDIO_DEV_MODE=1`)
- Required env vars / secrets for prod deployment
- GitHub App setup reference

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md fly.toml
git commit -m "docs: document prod/dev operating modes and new env vars"
```

---

### Task 8: Set Fly.io Secrets

**Files:** None (CLI operations)

- [ ] **Step 1: Set GitHub App secrets on Fly.io**

```bash
fly secrets set GITHUB_APP_ID=3076722 --app electric-agent
fly secrets set GITHUB_INSTALLATION_ID=115915587 --app electric-agent
fly secrets set GITHUB_PRIVATE_KEY="$(cat /Users/vbalegas/Downloads/electric-agent-bot.2026-03-12.private-key.pem)" --app electric-agent
```

- [ ] **Step 2: Verify secrets are set**

```bash
fly secrets list --app electric-agent
```

Expected: `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY` listed

- [ ] **Step 3: Set rate limiting env vars (if not using defaults)**

```bash
fly secrets set MAX_TOTAL_SESSIONS=50 --app electric-agent
fly secrets set MAX_SESSIONS_PER_IP_PER_HOUR=5 --app electric-agent
fly secrets set MAX_SESSION_COST_USD=5 --app electric-agent
```
