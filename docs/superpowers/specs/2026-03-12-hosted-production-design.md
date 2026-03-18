# Hosted Production Mode — Design Spec

## Context

The create-electric-app studio currently operates as a single-mode application where users provide their own Claude API keys and GitHub tokens. For the hosted/production version, the service must run with a pre-configured Claude API key on the server, enforce rate limiting, and manage GitHub integration through a dedicated GitHub App — removing the need for users to provide any credentials.

## Goals

1. Separate the application into two distinct operating modes: **Prod** (hosted) and **Dev** (local)
2. Enforce multi-layer rate limiting in Prod mode
3. Manage GitHub repo creation via a GitHub App owned by the `electric-apps` org
4. Provide transparent git authentication in sandboxes via a credential helper
5. Update all existing documentation to reflect the two modes

## Non-goals

- User authentication or accounts
- Private repo support (all hosted repos are public)
- Billing or paid tiers
- New documentation (only update existing docs)

---

## Operating Modes

### Prod Mode

Active when `NODE_ENV=production` and `STUDIO_DEV_MODE` is unset or falsy.

| Aspect | Behavior |
|--------|----------|
| Claude API key | Pre-configured on server via `ANTHROPIC_API_KEY` env var. User never provides a key. |
| GitHub token | Not accepted from user. Server uses GitHub App installation tokens. |
| Start from repo | Disabled. Sessions start only from a natural-language description. |
| Rate limiting | Enabled (global + per-IP + per-session budget). |
| Repo creation | Via GitHub App on `electric-apps` org. Agent gate at end of first plan iteration. |
| UI | No API key field, no GitHub token field, no "Start from repo" option. Session cost visible. |

### Dev Mode

Active when `STUDIO_DEV_MODE=1` (local development).

| Aspect | Behavior |
|--------|----------|
| Claude API key | User provides their own key or OAuth token. |
| GitHub token | User provides their own GitHub token. |
| Start from repo | Enabled. User can resume from an existing repo. |
| Rate limiting | Disabled. |
| Repo creation | User manages repos with their own token. |
| UI | All fields visible. Current behavior preserved. |

---

## Rate Limiting

Three layers, all configurable via environment variables:

### 1. Global session cap — `MAX_TOTAL_SESSIONS`

Maximum number of active sessions across the entire server. When reached, new session creation returns `503 Service Unavailable` with a retry-after hint. In-memory counter tracking active sessions.

**Definition of "active session"**: a session whose sandbox has not been destroyed. The counter increments on sandbox creation and decrements when the sandbox is destroyed (via `POST /api/sessions/:id/stop`, `session_end` event, or stale session cleanup). Counter resets on server restart — acceptable since `ActiveSessions` also resets on restart.

### 2. Per-IP session rate — `MAX_SESSIONS_PER_IP_PER_HOUR`

Already exists. Sliding window per IP address. Checked on all session creation paths: `POST /api/sessions`, `POST /api/sessions/resume`, and `POST /api/rooms/:id/agents`. No changes needed beyond ensuring it is enforced in Prod mode on all paths.

### 3. Per-session cost budget — `MAX_SESSION_COST_USD`

Already exists. Accumulated from `SessionEnd` hook events. When budget is exceeded, session is marked as error and bridge is closed.

**UI gap**: The cost tracking events exist but are not surfaced in the UI. The session cost must be displayed to the user in Prod mode so they understand their remaining budget.

### Environment Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MAX_TOTAL_SESSIONS` | number | 50 | Max concurrent active sessions |
| `MAX_SESSIONS_PER_IP_PER_HOUR` | number | 5 | Max sessions per IP per hour |
| `MAX_SESSION_COST_USD` | number | 5 | Max cost in USD per session |

---

## GitHub Integration (Prod Mode)

### GitHub App

- **Org**: `electric-apps`
- **App ID**: 3076722
- **Installation ID**: 115915587
- **Permissions**: Repository Administration (Read & Write), Contents (Read & Write)

### Server-side secrets

Stored as Fly.io secrets (never in code or env files):

| Secret | Description |
|--------|-------------|
| `GITHUB_APP_ID` | GitHub App numeric ID |
| `GITHUB_INSTALLATION_ID` | Installation ID for the `electric-apps` org |
| `GITHUB_PRIVATE_KEY` | PEM-encoded private key for JWT signing |

### Installation Token Generation

The server generates GitHub installation tokens on-demand:

1. Build a JWT signed with `GITHUB_PRIVATE_KEY` (RS256, iss=`GITHUB_APP_ID`, exp=10min)
2. Call `POST https://api.github.com/app/installations/{GITHUB_INSTALLATION_ID}/access_tokens`
3. Receive an installation token (valid for 1 hour)
4. Return the token to the caller

Tokens are not cached — a fresh token is generated for each request to `POST /api/sessions/:id/github-token`. This avoids stale token issues when Sprites wake up after sleeping.

### New Endpoint

```
POST /api/sessions/:id/github-token
Authorization: Bearer <session-token>

Response: { "token": "<installation-token>", "expires_at": "<ISO timestamp>" }
```

- Authenticated with the existing session token (HMAC-SHA256)
- Only available in Prod mode
- Rate limited: max 10 token requests per session per hour
- Returns a fresh GitHub installation token scoped to the `electric-apps` org
- Installation token request includes `permissions` scoping: `{ "permissions": { "contents": "write", "administration": "write" } }` to limit blast radius

### Git Credential Helper

A custom git credential helper is installed in each Sprite sandbox. It transparently provides GitHub credentials to git operations without agent involvement.

**Setup** (during Sprite initialization):

```bash
# Write credential helper script
cat > /usr/local/bin/git-credential-electric << 'SCRIPT'
#!/bin/bash
# Only respond to "get" requests for github.com
if [ "$1" != "get" ]; then exit 0; fi

input=$(cat)
host=$(echo "$input" | grep "^host=" | cut -d= -f2)
if [ "$host" != "github.com" ]; then exit 0; fi

# Request fresh token from studio server
response=$(curl -s -w "\n%{http_code}" -X POST \
  -H "Authorization: Bearer ${SESSION_TOKEN}" \
  "${STUDIO_URL}/api/sessions/${SESSION_ID}/github-token")

http_code=$(echo "$response" | tail -1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" != "200" ]; then
  echo "git-credential-electric: failed to fetch token (HTTP $http_code)" >&2
  exit 1
fi

token=$(echo "$body" | jq -r '.token')
if [ -n "$token" ] && [ "$token" != "null" ]; then
  echo "protocol=https"
  echo "host=github.com"
  echo "username=x-access-token"
  echo "password=${token}"
else
  echo "git-credential-electric: invalid token response" >&2
  exit 1
fi
SCRIPT
chmod +x /usr/local/bin/git-credential-electric

# Configure git to use the helper
git config --global credential.helper electric
```

**Environment variables** added to Sprite during initialization (in `sprites.ts` `create()` method):
- `SESSION_TOKEN` — session auth token (derived from `sessionId` + `DS_SECRET`)
- `SESSION_ID` — session identifier (passed as parameter to `create()`)
- `STUDIO_URL` — server URL (from `resolveStudioUrl(config.port)`)

These must be written to the Sprite's env profile **after** `ensureBootstrapped()` completes, overriding the default `gh auth git-credential` helper set during bootstrap.

**Flow**:
1. Agent runs `git push` (or any git operation requiring auth)
2. Git invokes the credential helper
3. Helper calls `POST /api/sessions/:id/github-token` on the studio server
4. Server generates a fresh installation token via GitHub App JWT
5. Helper returns the token to git
6. Git completes the operation
7. If token expires mid-operation, git retries and the helper fetches a new one

### Repo Naming

Repos are created in the `electric-apps` org with the pattern:

```
electric-apps/electric-<project-name>
```

Where `<project-name>` is derived from the project name the user provides, sanitized for GitHub repo naming rules (lowercase, hyphens, no special chars). If a repo with that name already exists, append a short hash suffix (e.g. `electric-todo-app-a3f2`).

### Publish Gate

The agent includes a gate (ask_user) at the end of the first complete plan iteration:

> "Your app is ready! Would you like me to publish it to GitHub? It will be available as a public repository at github.com/electric-apps/electric-<name>."

If the user accepts:
1. Agent creates the repo via `gh repo create electric-apps/electric-<name> --public`
2. Agent pushes the code
3. Agent returns the repo URL to the user

If the user declines, the code remains only in the Sprite sandbox.

---

## UI Changes (Prod Mode)

### Hide

- API key input field
- GitHub token input field
- "Start from repo" / repo selection UI
- Any credential-related settings

### Show

- Session cost / budget indicator — display current spend vs `MAX_SESSION_COST_USD`
- Source: read `SessionInfo.totalCostUsd` (accumulated by server via `accumulateSessionCost`), delivered to client via session SSE stream or session status endpoint

### Conditional rendering

Use the existing `GET /api/config` endpoint which already returns `devMode`. Components check this flag to show/hide mode-specific UI.

---

## Server Changes Summary

### New code

| Component | Location | Description |
|-----------|----------|-------------|
| GitHub App token generator | `packages/studio/src/github-app.ts` | JWT signing + installation token exchange |
| GitHub token endpoint | `packages/studio/src/server.ts` | `POST /api/sessions/:id/github-token` |
| Global session limiter | `packages/studio/src/server.ts` | `MAX_TOTAL_SESSIONS` enforcement |
| Credential helper setup | `packages/studio/src/sandbox/sprites.ts` | Install git credential helper in Sprite |

### Modified code

| Component | Change |
|-----------|--------|
| `server.ts` — session creation | Gate credential fields behind `devMode`; in Prod, pass `process.env.ANTHROPIC_API_KEY` as `apiKey` to `sandbox.create()` |
| `server.ts` — resume endpoint | Return `403 Forbidden` on `POST /api/sessions/resume` when `!config.devMode` |
| `server.ts` — room agents | Apply same prod-mode treatment to `POST /api/rooms/:id/agents`: rate limiting, server-side API key, no user credentials |
| `server.ts` — GitHub routes | ~~Gate behind `devMode`~~ — **Updated**: GitHub API routes (`/api/github/accounts`, `/api/github/repos`, `/api/github/repos/:owner/:repo/branches`) are no longer gated on devMode; they work in any mode when a PAT is provided via `X-GH-Token` header |
| `sandbox/sprites.ts` — env setup | Install credential helper; set `STUDIO_URL`, `SESSION_TOKEN`, `SESSION_ID` |
| `api-schemas.ts` | Make `apiKey`, `oauthToken`, `ghToken` optional/ignored in Prod mode |
| Client UI components | Conditional rendering based on `devMode` from `/api/config` |

### Documentation updates

| File | Changes |
|------|---------|
| `CLAUDE.md` | Document two modes, new env vars, GitHub App config |
| `README.md` | Update setup instructions for both modes |
| `fly.toml` | Add new env var placeholders |
| Code comments | Update inline docs in modified files |

---

## Dependencies

No new npm dependencies required. GitHub App JWT signing uses Node.js built-in `crypto.createSign('RSA-SHA256')` — the JWT payload is simple (3 fields: `iss`, `iat`, `exp`) and can be constructed with `Buffer.from().toString('base64url')` + crypto signing.

---

## Security Considerations

- **Private key**: stored only as Fly.io secret, never in code or logs
- **Installation tokens**: ephemeral (1h), scoped to `electric-apps` org only
- **Credential helper**: tokens never written to disk, requested on-demand via authenticated API call
- **Session token validation**: GitHub token endpoint uses existing HMAC-SHA256 session auth
- **No user credentials in Prod**: eliminates credential storage/leaking risks in sandboxes
- **Public repos only**: no risk of leaking private code
- **Credential helper errors**: writes diagnostics to stderr (visible to git/agent) when studio server is unreachable
- **Repo lifecycle**: repos in `electric-apps` org are not automatically cleaned up — future work to archive repos untouched for 90+ days
