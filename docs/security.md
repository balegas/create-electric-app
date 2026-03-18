# Security & Authentication

Electric Agent uses stateless HMAC tokens for all authentication. There is no server-side token storage — tokens are derived deterministically from IDs and validated on every request.

## Credential Isolation

The studio server acts as a proxy between clients/sandboxes and Durable Streams. The `DS_SECRET` never leaves the server process:

```
Client ──session token──▶ Studio API ──DS_SECRET──▶ Durable Streams
Sandbox ──session token──▶ Studio API ──DS_SECRET──▶ Durable Streams
```

- Clients read events via the SSE proxy (`GET /api/sessions/:id/events`)
- Sandboxes write events via the append proxy (`POST /api/sessions/:id/stream/append`)
- All proxy endpoints authenticate callers with scoped HMAC tokens before forwarding to Durable Streams
- Bridge classes hold DS credentials as private internal state — they are not exposed on any public interface

## Session Token Authentication

Every session gets a unique token derived from the session ID:

```
Token = HMAC-SHA256(DS_SECRET, sessionId)  →  64-char hex string
```

### Flow

```
        Creation                              Subsequent Requests
        ────────                              ───────────────────

Server: sessionId = UUID                    Client sends:
        token = HMAC-SHA256(DS_SECRET,        Authorization: Bearer <token>
                             sessionId)
        Return { sessionId, sessionToken }  Server re-derives:
                                              expected = HMAC-SHA256(DS_SECRET, sessionId)
Client: Store in localStorage                Validates: timingSafeEqual(expected, token)
        (key: "electric-agent:session-tokens")
```

- **Secret**: Reuses `DS_SECRET` (Durable Streams JWT secret) — no additional secret needed.
- **Validation**: Uses `crypto.timingSafeEqual` to prevent timing attacks.
- **Stateless**: No database or in-memory token store — the token is re-derived on each request.

## Room Token Authentication

Rooms use the same HMAC mechanism, keyed on the room ID:

```
Token = HMAC-SHA256(DS_SECRET, roomId)  →  64-char hex string
```

Room tokens are transmitted via the `X-Room-Token` header (or `?token=` query param for SSE). This is separate from the `Authorization` header, which carries session tokens — endpoints that need both (e.g., adding an existing session to a room) can validate each independently.

The invite code serves as initial authentication — knowing the code grants the room token. After that, the room token is required for all subsequent requests.

```
        Creator                          Joiner (via invite code)
        ───────                          ────────────────────────

Server: roomId = UUID                   GET /api/rooms/join/:id/:code
        roomToken = HMAC(DS_SECRET,       → validates id + code match
                         roomId)          → returns { id, roomToken }
        Return { id, code, roomToken }
                                        Client stores roomToken in
Client: Store roomToken in               localStorage
        localStorage                    ("electric-agent:room-tokens")
        ("electric-agent:room-tokens")
```

## Hook Token Authentication

Hook events (forwarded from Claude Code's hook system) use purpose-scoped tokens:

### Per-Session Hook Token

```
Token = HMAC-SHA256(DS_SECRET, "hook:" + sessionId)
```

The `hook:` prefix prevents a session token from being used as a hook token and vice versa. Hook tokens are passed to sandbox environments (Sprites, Docker) and validated by the `/api/sessions/:id/hook-event` handler.

### Global Hook Secret

```
Token = HMAC-SHA256(DS_SECRET, "global-hook")
```

The global hook secret authenticates the unified `/api/hook` endpoint. It is embedded in the hook forwarder script so that only local Claude Code instances can post events.

## Protected vs Exempt Endpoints

### Session Endpoints

| Endpoint | Auth | Notes |
|----------|:----:|-------|
| `POST /api/sessions` | No | Creation — returns `sessionToken` |
| `POST /api/sessions/local` | No | Local creation — returns `sessionToken` |
| `POST /api/sessions/auto` | No | Auto creation — returns `sessionToken` |
| `POST /api/sessions/resume` | No | Resume — returns `sessionToken` |
| `GET /api/sessions/:id` | Session token | Header or query param |
| `DELETE /api/sessions/:id` | Session token | Header |
| `POST /api/sessions/:id/iterate` | Session token | Header |
| `POST /api/sessions/:id/respond` | Session token | Header |
| `GET /api/sessions/:id/events` | Session token | Query param (`?token=`) — EventSource limitation |
| `POST /api/sessions/:id/stream/append` | Session token | DS write proxy — Content-Type, size (64KB), and JSON validated |
| `GET /api/sessions/:id/app-status` | Session token | Header or query param |
| `POST /api/sessions/:id/*` | Session token | All other session sub-routes |

### Room Endpoints

All room-scoped endpoints (except creation and invite join) require a room token via the `X-Room-Token` header or `?token=` query param.

| Endpoint | Auth | Notes |
|----------|:----:|-------|
| `POST /api/rooms` | No | Create room — returns `roomToken` |
| `GET /api/rooms/join/:id/:code` | No | Invite code lookup — returns `roomToken` |
| `GET /api/rooms/:id` | Room token | Get room state |
| `POST /api/rooms/:id/agents` | Room token | Create new agent in room — returns `sessionToken` |
| `POST /api/rooms/:id/sessions` | Room token + Session token | Add existing session — `X-Room-Token` for room auth, `Authorization` for session ownership |
| `POST /api/rooms/:id/sessions/:sessionId/iterate` | Room token | Send message to specific agent |
| `POST /api/rooms/:id/messages` | Room token | Broadcast message to room |
| `GET /api/rooms/:id/events` | Room token | SSE stream — token via `?token=` query param |
| `POST /api/rooms/:id/close` | Room token | Close room |
| `POST /api/rooms/create-app` | No | Create room with agents — returns `roomToken` + session info |

### GitHub Endpoints

GitHub API endpoints are not gated on devMode. They work in any mode whenever a valid personal access token is provided via the `X-GH-Token` header. If no token is provided, they return empty results.

| Endpoint | Auth | Notes |
|----------|:----:|-------|
| `GET /api/github/accounts` | `X-GH-Token` header | List GitHub accounts (personal + orgs) |
| `GET /api/github/repos` | `X-GH-Token` header | List repos for the authenticated user |
| `GET /api/github/repos/:owner/:repo/branches` | `X-GH-Token` header | List branches for a repo |

### Hook Endpoints

| Endpoint | Auth | Notes |
|----------|:----:|-------|
| `POST /api/hook` | Global hook secret | Validated with `HMAC-SHA256(DS_SECRET, "global-hook")` |
| `POST /api/sessions/:id/hook-event` | Per-session hook token | Validated with `HMAC-SHA256(DS_SECRET, "hook:" + sessionId)` |

## Client Integration

**REST requests** (`api.ts`): The `request()` helper extracts the session ID from the URL path and attaches `Authorization: Bearer <token>` automatically. For room-scoped requests, it also attaches the `X-Room-Token` header.

**SSE/EventSource** (`useSession.ts`, `useRoomEvents.ts`): Since `EventSource` does not support custom headers, the token is passed as a `?token=` query parameter.

**Token lifecycle**: Tokens are captured from creation responses and stored via `setSessionToken()` / `setRoomToken()`. When a session or room is removed from localStorage, the corresponding token is also deleted.

## Input Validation

### Command Injection Prevention

Sandbox operations validate all user-controlled inputs before shell execution:

- **`shellQuote()`** — escapes single quotes for safe shell interpolation
- **`validateName()`** — restricts project/container names to `[a-zA-Z0-9._-]+`
- **`validateBranchName()`** — restricts git branch names to `[a-zA-Z0-9._\-/]+`
- **`validateRepoUrl()`** — validates URLs match expected `https://` or `git@` patterns
- **`execFile()`** — used instead of `exec()` where possible to avoid shell interpretation

### Stream Append Proxy

The `/api/sessions/:id/stream/append` proxy validates:
- **Content-Type**: Must be `application/json` (415 otherwise)
- **Body size**: Maximum 64KB (413 otherwise)
- **JSON validity**: Body must parse as valid JSON (400 otherwise)

## Hono Middleware

Session and room middleware layers in `server.ts` enforce auth:

```typescript
app.use("/api/sessions/:id/*", ...)  // Session sub-resource routes
app.use("/api/sessions/:id", ...)    // Session base path (GET/DELETE only)
app.use("/api/rooms/:id/*", ...)     // Room sub-resource routes
app.use("/api/rooms/:id", ...)       // Room base path (GET/DELETE only)
app.use("/api/hook", ...)            // Global hook secret
```

**Routing caveat**: `app.use("/api/sessions/:id/*")` also matches creation routes like `/api/sessions/local` (Hono treats `local` as `:id`). The middleware skips an explicit set of exempt IDs (`local`, `auto`, `resume`). New creation routes under `/api/sessions/<name>` must be added to `authExemptIds`.

## External Credentials

| Variable | Scope | Purpose |
|----------|-------|---------|
| `DS_SECRET` | Server only | HMAC key for all token derivation + Durable Streams auth |
| `DS_URL` | Server only | Durable Streams API URL |
| `DS_SERVICE_ID` | Server only | Durable Streams service ID |
| `ANTHROPIC_API_KEY` | Server + sandbox | Claude API access |
| `CLAUDE_CODE_OAUTH_TOKEN` | Server + sandbox | Alternative Claude auth |
| `GH_TOKEN` | Server + sandbox | GitHub repo/PR operations |
| `ELECTRIC_SECRET` | Sandbox only | Electric sync service auth |
| `DATABASE_URL` | Sandbox only | Postgres connection string |
