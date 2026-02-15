# Roadmap: Sandbox Options & Cloud Deployment

Follow-up plan for adding sandbox execution and cloud deployment to `electric-agent`.

---

## Context

Today the coder agent runs on the local OS with `permissionMode: "bypassPermissions"` — full filesystem and shell access in the user's working directory. This works for local development but blocks two capabilities:

1. **Hosted generation** — run agent remotely so the user doesn't need Node/Docker locally
2. **Direct deploy** — push the generated app to cloud hosting in one step

The Agent SDK provides `SandboxSettings` for local OS-level sandboxing (Linux bubblewrap / macOS seatbelt) and documents several cloud sandbox providers for hosted execution. We layer on top of both.

When running locally, files are already on disk — no packaging needed. When running in a cloud sandbox, packaging is inherent: `extractFiles()` on the sandbox handle is the only way to get files out.

---

## Phase 1: Sandbox Abstraction Layer

**Goal:** The coder agent runs in an isolated sandbox. Local OS sandbox is the default; cloud sandbox is opt-in. Cloud sandboxes include file extraction (packaging) as part of the handle.

### 1.1 — Sandbox interface

```typescript
// src/sandbox/types.ts
interface SandboxProvider {
  name: string
  /** Prepare the sandbox environment (clone template, install deps) */
  setup(projectDir: string): Promise<SandboxHandle>
  /** Tear down the sandbox */
  teardown(handle: SandboxHandle): Promise<void>
}

interface SandboxHandle {
  /** Working directory inside the sandbox */
  cwd: string
  /** SDK sandbox settings to pass to query() */
  sandboxSettings: SandboxSettings
  /** Environment variables to inject */
  env: Record<string, string>
  /**
   * Extract files from the sandbox.
   * Local: no-op (files are already on disk).
   * Cloud: tar.gz the project dir (minus node_modules, _agent, .env, .git)
   *        and download to destDir.
   */
  extractFiles(destDir: string): Promise<string>
  /**
   * Upload extracted archive to object storage, return signed URL.
   * Only available on cloud sandboxes. Local throws.
   */
  hostDownload?(): Promise<{ url: string; expiresAt: Date }>
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
        network: {
          allowLocalBinding: true,       // dev server needs ports
        },
        excludedCommands: ["docker"],     // docker compose needs host access
      },
      env: process.env as Record<string, string>,
      async extractFiles() {
        // local — files are already on disk
        return projectDir
      },
    }
  },
  async teardown() {},
}
```

### 1.3 — Cloud sandbox (Fly Machines first)

| Provider | Fit | Notes |
|----------|-----|-------|
| **Fly Machines** | Best for long-running generation (5+ min) | Ephemeral VMs, fast boot, good disk I/O |
| **E2B** | Good for short tasks | 10-min timeout on free tier |
| **Modal Sandbox** | Best for burst compute | GPU support if needed later |
| **Cloudflare Sandboxes** | Lightweight | Better for hosting than generation |

Start with **Fly Machines** — no execution time limits, ephemeral session pattern.

```typescript
// src/sandbox/fly.ts (sketch)
export const flySandbox: SandboxProvider = {
  name: "fly",
  async setup(projectDir) {
    // 1. Create Fly Machine from base image (Node 22 + Docker)
    // 2. Upload project scaffold via Fly Machine API
    // 3. sandboxSettings.enabled = false (container IS the sandbox)
    return {
      cwd: "/app",
      sandboxSettings: { enabled: false },
      env: { /* remote DB URLs, etc. */ },
      async extractFiles(destDir) {
        // tar.gz project in machine, download via Fly API
        // excludes: node_modules/, _agent/, .env, .git/
      },
      async hostDownload() {
        // upload tar.gz to Tigris/R2, return signed URL (24h expiry)
      },
    }
  },
  async teardown(handle) {
    // Destroy the Fly Machine
  },
}
```

### 1.4 — Wire into CLI

```
electric-agent new "a todo app"                      # local sandbox (default)
electric-agent new "a todo app" --sandbox fly         # Fly Machine sandbox
electric-agent new "a todo app" --sandbox local       # explicit local
electric-agent new "a todo app" --sandbox none        # no sandbox (current behavior)
```

### 1.5 — Tasks

- [ ] Define `SandboxProvider` and `SandboxHandle` interfaces in `src/sandbox/types.ts`
- [ ] Implement `localSandbox` provider in `src/sandbox/local.ts`
- [ ] Implement `flySandbox` provider in `src/sandbox/fly.ts`
- [ ] Add `--sandbox` flag to CLI commands (`new`, `iterate`)
- [ ] Create `src/sandbox/index.ts` registry that resolves provider by name
- [ ] Update `runCoder()` and `runPlanner()` to accept a `SandboxHandle`
- [ ] Add sandbox configuration to `_agent/session.md` tracking
- [ ] Test: local sandbox blocks writes outside project directory
- [ ] Test: Fly sandbox creates/destroys machine, extractFiles returns tar.gz
- [ ] Document: sandbox options in README

---

## Phase 2: Direct Cloud Deployment

**Goal:** `electric-agent deploy` pushes the generated app to cloud hosting. The app is live at a URL.

### 2.1 — Target architecture

```
Cloudflare Pages (free)                 Fly.io Machine (~$2-5/mo)
├── TanStack Start SSR (edge)           ├── Postgres 17 + Electric
├── Static assets (global CDN)          ├── API mutation routes
└── Client-side Electric sync           └── Caddy reverse proxy
```

### 2.2 — Deploy command

```bash
electric-agent deploy                    # deploy to default (Cloudflare + Fly)
electric-agent deploy --provider fly     # Fly only (monolith)
electric-agent deploy --provider cf      # Cloudflare Pages only (static/SSR)
electric-agent deploy --preview          # deploy as preview (e.g., PR preview)
```

### 2.3 — Deployment flow

```
electric-agent deploy
│
├── 1. Build production bundle
│   └── pnpm build (TanStack Start → server + client bundles)
│
├── 2. Deploy database + Electric (Fly)
│   ├── Create Fly app (if first deploy)
│   ├── Provision Fly Postgres (or use existing)
│   ├── Deploy Electric as Fly Machine
│   ├── Run drizzle-kit migrate against remote DB
│   └── Return ELECTRIC_URL + DATABASE_URL
│
├── 3. Deploy web app (Cloudflare Pages)
│   ├── Build with remote env vars (ELECTRIC_URL, DATABASE_URL)
│   ├── wrangler pages deploy ./dist/
│   └── Return app URL
│
└── 4. Output
    ├── App URL: https://my-todo-app.pages.dev
    ├── API URL: https://my-todo-app-api.fly.dev
    ├── Electric: https://my-todo-app-api.fly.dev/electric
    └── Database: postgres://... (Fly Postgres)
```

### 2.4 — Tasks

- [ ] Implement `src/deploy/types.ts` — deploy provider interface
- [ ] Implement `src/deploy/fly.ts` — Fly Machines deploy (Postgres + Electric + API)
- [ ] Implement `src/deploy/cloudflare.ts` — Cloudflare Pages deploy (SSR + static)
- [ ] Implement `src/deploy/index.ts` — orchestrates full deploy (Fly + CF)
- [ ] Add `electric-agent deploy` CLI command in `src/cli/deploy.ts`
- [ ] Add `--provider`, `--preview` flags
- [ ] Generate `.github/workflows/preview.yml` into deployed apps
- [ ] Handle secrets management (Fly API token, Cloudflare API token)
- [ ] Configure TanStack Start for edge deployment on Cloudflare Pages
- [ ] Test: full deploy to Fly + Cloudflare produces live, working app
- [ ] Test: preview deploy creates isolated instance
- [ ] Test: teardown removes all cloud resources

---

## Phase 3: Hosted Generation Service (Web UI)

**Goal:** Users visit a website, describe an app, and get a running preview — no local setup required.

### 3.1 — Architecture

```
Browser                    API Server (Fly)              Sandbox (Fly Machine)
│                          │                             │
│  "a todo app"  ────────> │  POST /api/sessions         │
│                          │  ├── Create Fly Machine ───>│ Boot + scaffold
│                          │  └── Return session ID      │
│                          │                             │
│  SSE stream    <──────── │  GET /api/progress/:id      │
│  [plan] ...              │  ├── Proxy SSE from ───────>│ Planner + Coder
│  [task] ...              │  │   sandbox                │ agents running
│  [build] pass            │  │                          │
│                          │                             │
│  Preview iframe <──────  │  GET /api/preview/:id/* ──> │ :5173 (dev server)
│                          │                             │
│  Download      <──────── │  GET /api/download/:id      │ extractFiles()
│  Deploy button ────────> │  POST /api/deploy/:id       │ → Phase 2 flow
```

### 3.2 — Web UI stack

| Component | Technology | Hosting |
|-----------|-----------|---------|
| Web UI | TanStack Start | Cloudflare Pages (free) |
| API server | Hono | Fly.io Machine |
| Generation sandbox | Agent SDK + CLI | Fly.io Machine (per-session, ephemeral) |
| Object storage | Tigris (Fly-native) | Fly.io |

### 3.3 — Web UI project structure

```
web/
├── package.json
├── wrangler.toml              # Cloudflare Pages config
├── src/
│   ├── routes/
│   │   ├── index.tsx          # Landing page + generation form
│   │   ├── session.$id.tsx    # Progress view + preview iframe
│   │   └── api/
│   │       ├── sessions.ts    # POST: create session → Fly Machine
│   │       ├── progress.$id.ts # GET: SSE proxy from sandbox
│   │       ├── preview.$id.ts # GET: reverse proxy sandbox dev server
│   │       └── download.$id.ts # GET: signed download URL
│   └── components/
│       ├── GenerationForm.tsx
│       ├── ProgressStream.tsx # SSE consumer, renders agent output
│       └── PreviewFrame.tsx   # iframe pointing at sandbox dev server
```

### 3.4 — API server structure

```
api/
├── package.json
├── fly.toml                   # Fly.io deployment config
├── Dockerfile
├── src/
│   ├── index.ts               # Hono app entry
│   ├── routes/
│   │   ├── sessions.ts        # Create/list/get sessions
│   │   ├── progress.ts        # SSE proxy
│   │   ├── preview.ts         # Reverse proxy to sandbox
│   │   └── download.ts        # Signed URL generation
│   ├── sandbox/
│   │   └── manager.ts         # Fly Machine lifecycle (create/destroy)
│   └── storage/
│       └── tigris.ts          # Object storage for downloads
```

### 3.5 — Tasks

- [ ] Scaffold `web/` directory (TanStack Start on Cloudflare Pages)
- [ ] Scaffold `api/` directory (Hono on Fly.io)
- [ ] Implement API: `POST /api/sessions` — create Fly Machine, start agent
- [ ] Implement API: `GET /api/progress/:id` — SSE proxy from sandbox
- [ ] Implement API: `GET /api/preview/:id/*` — reverse proxy sandbox dev server
- [ ] Implement API: `GET /api/download/:id` — extract files, upload, return signed URL
- [ ] Implement API: `POST /api/deploy/:id` — trigger Phase 2 deploy flow
- [ ] Implement Web UI: landing page with generation form
- [ ] Implement Web UI: progress stream view (SSE consumer)
- [ ] Implement Web UI: preview iframe
- [ ] Implement Web UI: download + deploy buttons
- [ ] Add `.github/workflows/deploy-web.yml` for CI/CD
- [ ] Rate limiting, auth, abuse prevention
- [ ] Cost tracking per session (Agent SDK `maxBudgetUsd` + sandbox compute)

---

## Implementation Order

```
Phase 1 (Sandbox)     ──── Foundation. Includes file extraction for cloud.
    │
    ├── Phase 2 (Deploy)     ──── High value. Makes generated apps production-ready.
    │
    └── Phase 3 (Web UI)     ──── Full product. Requires Phase 1 + 2.
```

### Estimated scope

| Phase | New files | Complexity | Dependencies |
|-------|-----------|------------|--------------|
| 1 — Sandbox | ~5 | Medium | Agent SDK sandbox API, Fly Machines API |
| 2 — Deploy | ~5 | High | Fly CLI, Wrangler CLI, TanStack Start edge config |
| 3 — Web UI | ~15 | High | Hono, TanStack Start, SSE, Fly Machines API, Tigris |

---

## Decision Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Default sandbox | Local OS (bubblewrap/seatbelt) | Zero config, works offline, Agent SDK native |
| Packaging | Part of sandbox handle, not a separate feature | Local = files on disk. Cloud = extractFiles() is only way out |
| First cloud provider | Fly Machines | No execution time limits, good disk I/O, cheapest for persistent DB |
| Web hosting | Cloudflare Pages | Free tier, global CDN, per-PR previews included |
| API/DB hosting | Fly.io | Postgres + Electric need persistent server; Fly is cheapest |
| Architecture | Split (CF Pages + Fly) | $2/mo vs $12/mo for 5 active PRs |
| Object storage | Tigris (Fly-native) | No egress fees from Fly, S3-compatible API |
| API framework | Hono | Lightweight, works on Fly + CF Workers, good TypeScript support |

---

## Open Questions

1. **Auth for hosted service** — API keys? GitHub OAuth? Anonymous with rate limits?
2. **Cost model for hosted generation** — Free tier with limits? Pay per generation?
3. **Multi-region** — Start single-region (iad) or multi from day one?
4. **Electric Cloud** — Use Electric's managed service instead of self-hosting on Fly?
