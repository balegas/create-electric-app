# Roadmap: Sandbox Options & Cloud Deployment

Follow-up plan for adding sandbox execution and cloud deployment to `electric-agent`.

---

## Context

Today the coder agent runs on the local OS with `permissionMode: "bypassPermissions"` — full filesystem and shell access in the user's working directory. This works for local development but blocks hosted generation — running the agent remotely so the user doesn't need Node/Docker locally.

The Agent SDK provides `SandboxSettings` for local OS-level sandboxing (Linux bubblewrap / macOS seatbelt). For hosted execution, the CLI runs inside a **Sprite** (Anthropic's cloud sandbox). The web UI creates the Sprite, the CLI runs inside it, and progress streams back to the browser via **Durable Streams**.

When running locally, files are already on disk — no packaging needed. When running in a Sprite, `extractFiles()` on the sandbox handle is the only way to get files out.

Note: the CLI runs in CI only for testing. Running it from CI is not a use case.

---

## Phase 1: Sandbox Abstraction Layer

**Goal:** The coder agent runs in an isolated sandbox. Local OS sandbox is the default; Sprites are used when invoked from the web UI.

### 1.1 — Sandbox interface

```typescript
// src/sandbox/types.ts
interface SandboxProvider {
  name: string
  setup(projectDir: string): Promise<SandboxHandle>
  teardown(handle: SandboxHandle): Promise<void>
}

interface SandboxHandle {
  cwd: string
  sandboxSettings: SandboxSettings
  env: Record<string, string>
  /**
   * Local: returns projectDir (files already on disk).
   * Sprite: tar.gz the project (minus node_modules, _agent, .env, .git),
   *         download to destDir.
   */
  extractFiles(destDir: string): Promise<string>
}
```

### 1.2 — Local OS sandbox (default)

Uses the Agent SDK's built-in `SandboxSettings` — bubblewrap on Linux, seatbelt on macOS.

```typescript
// src/sandbox/local.ts
export const localSandbox: SandboxProvider = {
  name: "local",
  async setup(projectDir) {
    return {
      cwd: projectDir,
      sandboxSettings: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        network: { allowLocalBinding: true },
        excludedCommands: ["docker"],
      },
      env: process.env as Record<string, string>,
      async extractFiles() { return projectDir },
    }
  },
  async teardown() {},
}
```

### 1.3 — Sprite sandbox (hosted)

When the web UI creates a Sprite, the CLI runs inside it. The Sprite IS the sandbox — no OS-level sandboxing needed inside.

```typescript
// src/sandbox/sprite.ts
export const spriteSandbox: SandboxProvider = {
  name: "sprite",
  async setup(projectDir) {
    return {
      cwd: projectDir,
      sandboxSettings: { enabled: false },
      env: process.env as Record<string, string>,
      async extractFiles(destDir) {
        // tar.gz project, exclude node_modules/_agent/.env/.git
      },
    }
  },
  async teardown() {},
}
```

### 1.4 — CLI flags

```
electric-agent new "a todo app"                      # local sandbox (default)
electric-agent new "a todo app" --sandbox local       # explicit local
electric-agent new "a todo app" --sandbox none        # no sandbox (current behavior)
```

When running inside a Sprite, the CLI detects it automatically (environment marker) — no flag needed.

### 1.5 — Tasks

- [ ] Define `SandboxProvider` and `SandboxHandle` interfaces in `src/sandbox/types.ts`
- [ ] Implement `localSandbox` in `src/sandbox/local.ts`
- [ ] Implement `spriteSandbox` in `src/sandbox/sprite.ts`
- [ ] Auto-detect Sprite environment (env var or filesystem marker)
- [ ] Add `--sandbox` flag to CLI (`new`, `iterate`)
- [ ] Create `src/sandbox/index.ts` registry
- [ ] Update `runCoder()` and `runPlanner()` to accept `SandboxHandle`
- [ ] Test: local sandbox blocks writes outside project directory
- [ ] Test: Sprite sandbox extractFiles produces tar.gz

---

## Phase 2: Durable Streams Integration

**Goal:** The CLI streams progress to the web UI over Durable Streams while running inside a Sprite.

### 2.1 — How it works

```
Sprite                              Durable Streams Server           Browser
│                                   │                                │
│ electric-agent new "todo app"     │                                │
│   ├── [plan] generating...  ────> │  stream.write(event)           │
│   ├── [task] schema...      ────> │  ──────────────────────> SSE ──> UI
│   ├── [build] pass          ────> │                                │
│   └── [done]                ────> │                                │
│                                   │                                │
│ extractFiles() ──── tar.gz ─────> │  (or direct download)          │
```

The CLI already has a `ProgressReporter` that transforms agent messages into prefixed output (`[plan]`, `[task]`, `[build]`). We add a Durable Streams transport alongside the terminal transport.

### 2.2 — CLI configuration

```bash
# Environment variables (set by the web UI when creating the Sprite)
DURABLE_STREAMS_URL=https://streams.example.com
DURABLE_STREAMS_AUTH=Bearer <token>
DURABLE_STREAMS_ID=session-abc123
```

When these env vars are present, the reporter writes events to the Durable Stream in addition to stdout. When absent, stdout only (normal CLI behavior).

### 2.3 — Event schema

```typescript
type ProgressEvent =
  | { type: "plan"; content: string }
  | { type: "task"; phase: number; task: string; status: "start" | "done" }
  | { type: "build"; status: "pass" | "fail"; errors?: string[] }
  | { type: "file"; path: string; action: "create" | "edit" }
  | { type: "done"; downloadUrl?: string }
  | { type: "error"; message: string }
```

### 2.4 — Tasks

- [ ] Add Durable Streams client to `src/progress/durable-stream.ts`
- [ ] Read `DURABLE_STREAMS_URL`, `DURABLE_STREAMS_AUTH`, `DURABLE_STREAMS_ID` from env
- [ ] Update `ProgressReporter` to write to Durable Stream when env vars are present
- [ ] Define `ProgressEvent` schema
- [ ] Test: events appear on Durable Stream when env vars set
- [ ] Test: CLI works normally (stdout only) when env vars are absent

---

## Phase 3: Web UI + Sprites

**Goal:** Users visit a website, describe an app, watch generation progress, and download the result.

### 3.1 — Architecture

```
Browser ──> Cloudflare Pages (web UI)
                │
                ├── Pages Function: POST /api/create
                │   └── Sprites API: create Sprite
                │   └── Run: electric-agent new "..." inside Sprite
                │   └── Pass env: DURABLE_STREAMS_URL, DURABLE_STREAMS_AUTH,
                │                 DURABLE_STREAMS_ID, ANTHROPIC_API_KEY
                │
                ├── Client-side: EventSource(DURABLE_STREAMS_URL/session-id)
                │   └── Read progress events from Durable Stream, render UI
                │
                └── Pages Function: GET /api/download/:id
                    └── Sprites API: extract files from Sprite → tar.gz
```

No custom API server. The web UI talks to:
- **Sprites API** (via Pages Functions) — create Sprite, extract files
- **Durable Streams** (directly from browser) — read progress events

### 3.2 — Web UI project structure

```
web/
├── package.json
├── wrangler.toml
├── src/
│   ├── routes/
│   │   ├── index.tsx              # Landing page + generation form
│   │   └── session.$id.tsx        # Progress view + download
│   ├── api/                       # Cloudflare Pages Functions
│   │   ├── create.ts              # POST: create Sprite, start CLI
│   │   └── download.$id.ts        # GET: extract files from Sprite
│   └── components/
│       ├── GenerationForm.tsx     # App description input
│       ├── ProgressStream.tsx     # Durable Streams consumer
│       └── PreviewFrame.tsx       # (future) iframe to Sprite dev server
```

### 3.3 — Pages Functions (server-side, keeps secrets safe)

```typescript
// web/src/api/create.ts
export async function onRequestPost({ request, env }) {
  const { description } = await request.json()
  const streamId = crypto.randomUUID()

  // Create Sprite via Sprites API
  const sprite = await createSprite({
    apiKey: env.ANTHROPIC_API_KEY,
    command: `electric-agent new "${description}"`,
    env: {
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      DURABLE_STREAMS_URL: env.DURABLE_STREAMS_URL,
      DURABLE_STREAMS_AUTH: env.DURABLE_STREAMS_AUTH,
      DURABLE_STREAMS_ID: streamId,
    },
  })

  return Response.json({ sessionId: streamId, spriteId: sprite.id })
}
```

### 3.4 — Tasks

- [ ] Scaffold `web/` with TanStack Start on Cloudflare Pages
- [ ] Implement Pages Function: `POST /api/create` — create Sprite, start CLI
- [ ] Implement Pages Function: `GET /api/download/:id` — extract files from Sprite
- [ ] Implement landing page with generation form
- [ ] Implement progress view (Durable Streams EventSource consumer)
- [ ] Implement download button (extract from Sprite → tar.gz)
- [ ] Rate limiting, auth, abuse prevention
- [ ] Cost tracking per session

---

## Phase 4: Direct Cloud Deployment (Future)

**Goal:** After generation, deploy the app directly to cloud hosting from the Sprite.

### 4.1 — Target architecture

```
Cloudflare Pages (free)                 Fly.io Machine (~$2-5/mo)
├── TanStack Start SSR (edge)           ├── Postgres 17 + Electric
├── Static assets (global CDN)          ├── API mutation routes
└── Client-side Electric sync           └── Caddy reverse proxy
```

### 4.2 — Deploy from Sprite

The Sprite already has the generated app. Run `electric-agent deploy` inside it:

```
electric-agent deploy                    # deploy to Cloudflare + Fly
electric-agent deploy --provider fly     # Fly only (monolith)
electric-agent deploy --preview          # PR preview
```

### 4.3 — Tasks

- [ ] Implement `src/deploy/types.ts` — deploy provider interface
- [ ] Implement `src/deploy/fly.ts` — Fly deploy (Postgres + Electric)
- [ ] Implement `src/deploy/cloudflare.ts` — Cloudflare Pages deploy
- [ ] Add `electric-agent deploy` CLI command
- [ ] Add deploy button to web UI (calls deploy inside Sprite)

---

## Implementation Order

```
Phase 1 (Sandbox)             ──── Foundation. Local sandbox + Sprite detection.
    │
    ├── Phase 2 (Durable Streams) ── CLI → web UI communication channel.
    │
    ├── Phase 3 (Web UI)          ── Sprites + Durable Streams + CF Pages.
    │
    └── Phase 4 (Deploy)          ── Push generated app to cloud hosting.
```

### Estimated scope

| Phase | New files | Complexity | Dependencies |
|-------|-----------|------------|--------------|
| 1 — Sandbox | ~4 | Medium | Agent SDK sandbox settings |
| 2 — Durable Streams | ~2 | Low | Durable Streams client |
| 3 — Web UI | ~8 | Medium | Sprites API, Cloudflare Pages Functions |
| 4 — Deploy | ~5 | High | Fly CLI, Wrangler CLI |

---

## Decision Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Default sandbox | Local OS (bubblewrap/seatbelt) | Zero config, works offline, Agent SDK native |
| Hosted execution | Sprites (Anthropic) | Purpose-built for Agent SDK, managed lifecycle |
| CLI ↔ web UI comms | Durable Streams | Persistent, resumable, auth via custom header |
| Web hosting | Cloudflare Pages | Free, global CDN, Pages Functions for server-side secrets |
| No custom API server | Pages Functions + Sprites API | Sprites handle execution; no intermediary needed |
| Packaging | Part of sandbox handle | Local = on disk. Sprite = extractFiles() is only way out |
| CI | Testing only | CLI is not run from CI — CI just builds + tests the tool itself |

---

## Open Questions

1. **Auth for web UI** — API keys? GitHub OAuth? Anonymous with rate limits?
2. **Cost model** — Free tier with limits? Pay per generation?
3. **Sprite image** — Pre-built with CLI + deps? Or install on boot?
4. **Electric Cloud** — Use Electric's managed service instead of self-hosting?
