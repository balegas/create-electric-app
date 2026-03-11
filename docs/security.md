# Security & Authentication

Electric Agent uses stateless HMAC tokens for all authentication. There is no server-side token storage — tokens are derived deterministically from IDs and validated on every request.

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

Hook events (forwarded from Claude Code's hook system) use a purpose-scoped token:

```
Token = HMAC-SHA256(DS_SECRET, "hook:" + sessionId)
```

The `hook:` prefix prevents a session token from being used as a hook token and vice versa. Hook tokens are passed to sandbox environments (Sprites, Docker) and validated by the `/api/sessions/:id/hook-event` handler.

## Protected vs Exempt Endpoints

### Session Endpoints

| Endpoint | Auth | Notes |
|----------|:----:|-------|
| `POST /api/sessions` | No | Creation — returns `sessionToken` |
| `POST /api/sessions/local` | No | Local creation — returns `sessionToken` |
| `POST /api/sessions/auto` | No | Auto creation — returns `sessionToken` |
| `POST /api/sessions/resume` | No | Resume — returns `sessionToken` |
| `GET /api/sessions/:id` | Yes | Header or query param |
| `DELETE /api/sessions/:id` | Yes | Header |
| `POST /api/sessions/:id/iterate` | Yes | Header |
| `POST /api/sessions/:id/respond` | Yes | Header |
| `GET /api/sessions/:id/events` | Yes | Query param (`?token=`) — EventSource limitation |
| `GET /api/sessions/:id/app-status` | Yes | Header or query param |
| `POST /api/sessions/:id/*` | Yes | All other session sub-routes |

### Room Endpoints

Rooms (`/api/rooms/*`) currently rely on the studio being deployed behind a trusted network boundary (local or reverse proxy) rather than per-request token auth. The legacy `/api/shared-sessions/*` endpoints are still functional but deprecated — new clients should use `/api/rooms/*`.

| Endpoint | Auth | Notes |
|----------|:----:|-------|
| `POST /api/rooms` | No | Create room — returns `roomToken` |
| `GET /api/rooms/join/:id/:code` | No | Invite code lookup — returns `roomToken` |
| `GET /api/rooms/:id` | No | Get room state |
| `POST /api/rooms/:id/agents` | No | Create new agent in room — returns `sessionToken` |
| `POST /api/rooms/:id/sessions` | Session token | Add existing session to room — caller must prove ownership |
| `POST /api/rooms/:id/sessions/:sessionId/iterate` | No | Send message to specific agent |
| `POST /api/rooms/:id/messages` | No | Broadcast message to room |
| `GET /api/rooms/:id/events` | No | SSE stream of room events |
| `POST /api/rooms/:id/close` | No | Close room |

**Trust boundary note**: Most room endpoints are unauthenticated — they rely on the studio running behind a trusted network boundary. The exception is `POST /api/rooms/:id/sessions`, which requires the caller to present a valid session token (via `Authorization: Bearer <token>`) for the session being added. This prevents privilege escalation: without owning the session token, an attacker cannot hijack an existing session by adding it to a room. The response does not return the session token — the caller must already have it.

### Hook Endpoints

| Endpoint | Auth | Notes |
|----------|:----:|-------|
| `POST /api/hook` | No | Local hook forwarder — no session param |
| `POST /api/sessions/:id/hook-event` | Hook token | Validated with purpose-scoped HMAC |

## Client Integration

**REST requests** (`api.ts`): The `request()` helper extracts the session ID from the URL path and attaches `Authorization: Bearer <token>` automatically.

**SSE/EventSource** (`useSession.ts`): Since `EventSource` does not support custom headers, the token is passed as a `?token=` query parameter.

**Token lifecycle**: Tokens are captured from creation responses and stored via `setSessionToken()`. When a session is removed from localStorage, the corresponding token is also deleted.

## Hono Middleware

Two middleware layers in `server.ts` enforce auth:

```typescript
app.use("/api/sessions/:id/*", ...)  // Sub-resource routes
app.use("/api/sessions/:id", ...)    // Base path (GET/DELETE only)
```

**Routing caveat**: `app.use("/api/sessions/:id/*")` also matches creation routes like `/api/sessions/local` (Hono treats `local` as `:id`). The middleware skips an explicit set of exempt IDs (`local`, `auto`, `resume`). New creation routes under `/api/sessions/<name>` must be added to `authExemptIds`.

## External Credentials

| Variable | Purpose | Required? |
|----------|---------|-----------|
| `DS_SECRET` | HMAC key for all token derivation | Yes |
| `DS_URL` | Durable Streams API URL | Yes |
| `DS_SERVICE_ID` | Durable Streams service ID | Yes |
| `ANTHROPIC_API_KEY` | Claude API access | Yes (or OAuth) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Alternative Claude auth | Optional |
| `GH_TOKEN` | GitHub repo/PR operations | Optional |
