# Roadmap: Sandbox Options & Cloud Deployment

Follow-up plan for adding sandbox execution, app hosting, and cloud deployment to `electric-agent`.

---

## Context

Today the coder agent runs on the local OS with `permissionMode: "bypassPermissions"` — full filesystem and shell access in the user's working directory. This works for local development but blocks three capabilities:

1. **Hosted generation** — run agent remotely so the user doesn't need Node/Docker locally
2. **Downloadable output** — package the generated app for download
3. **Direct deploy** — push the generated app to cloud hosting in one step

The Agent SDK provides `SandboxSettings` for local OS-level sandboxing (Linux bubblewrap / macOS seatbelt) and documents several cloud sandbox providers for hosted execution. We layer on top of both.

---

## Phase 1: Sandbox Abstraction Layer

**Goal:** The coder agent runs in an isolated sandbox. Local OS sandbox is the default; cloud sandbox (Sprites or other providers) is opt-in.

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
  /** Copy files out of the sandbox */
  extractFiles(destDir: string): Promise<void>
}
```

### 1.2 — Local OS sandbox (default)

Uses the Agent SDK's built-in `SandboxSettings` — bubblewrap on Linux, seatbelt on macOS.

```typescript
// src/sandbox/local.ts
import type { SandboxProvider, SandboxHandle } from "./types.js"

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
      async extractFiles(destDir) {
        // local — files are already on disk, just copy
        await cp(projectDir, destDir, { recursive: true })
      },
    }
  },
  async teardown() {
    // no-op for local
  },
}
```

### 1.3 — Cloud sandbox providers

Implement adapters for cloud providers listed in the Agent SDK hosting docs. Start with **one** provider, add more later.

| Provider | Fit | Notes |
|----------|-----|-------|
| **Fly Machines** | Best for long-running generation (5+ min) | Ephemeral VMs, fast boot, good disk I/O |
| **E2B** | Good for short tasks | 10-min timeout on free tier |
| **Modal Sandbox** | Best for burst compute | GPU support if needed later |
| **Cloudflare Sandboxes** | Lightweight | Better for hosting than generation |
| **Vercel Sandbox** | Quick prototyping | Limited execution time |

Start with **Fly Machines** — most aligned with the ephemeral session pattern and no execution time limits.

```typescript
// src/sandbox/fly.ts (sketch)
export const flySandbox: SandboxProvider = {
  name: "fly",
  async setup(projectDir) {
    // 1. Create Fly Machine from base image (Node 22 + Docker)
    // 2. Upload project scaffold via Fly Machine API
    // 3. Return handle with SSH/API access details
    // 4. sandboxSettings.enabled = false (container IS the sandbox)
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

### 1.5 — Wire into coder agent

```typescript
// In runCoder():
const handle = await provider.setup(projectDir)

for await (const message of query({
  prompt: generateMessages(),
  options: {
    sandbox: handle.sandboxSettings,
    cwd: handle.cwd,
    env: handle.env,
    // ... rest of options
  },
})) { ... }

await provider.teardown(handle)
```

### 1.6 — Tasks

- [ ] Define `SandboxProvider` and `SandboxHandle` interfaces in `src/sandbox/types.ts`
- [ ] Implement `localSandbox` provider in `src/sandbox/local.ts`
- [ ] Implement `flySandbox` provider in `src/sandbox/fly.ts`
- [ ] Add `--sandbox` flag to CLI commands (`new`, `iterate`)
- [ ] Create `src/sandbox/index.ts` registry that resolves provider by name
- [ ] Update `runCoder()` and `runPlanner()` to accept a `SandboxHandle`
- [ ] Add sandbox configuration to `_agent/session.md` tracking
- [ ] Test: local sandbox blocks writes outside project directory
- [ ] Test: Fly sandbox creates and destroys machine
- [ ] Document: sandbox options in README

---

## Phase 2: App Packaging & Download

**Goal:** After generation, the app is packaged and available for download — either locally or via a hosted URL.

### 2.1 — Local packaging

After the coder finishes, package the generated project:

```bash
electric-agent new "a todo app" --output ./my-app.tar.gz
```

- Strip `node_modules/`, `_agent/`, `.env` from the archive
- Include `README.md` with setup instructions
- Support `.tar.gz` and `.zip` formats

### 2.2 — Hosted packaging (requires cloud sandbox)

When running in a cloud sandbox, the generated app is already remote. Package and expose a download URL:

```
electric-agent new "a todo app" --sandbox fly --host-download

✓ App generated in Fly Machine
✓ Packaged as my-todo-app.tar.gz (2.4 MB)
✓ Download: https://electric-agent-dl.fly.dev/d/abc123/my-todo-app.tar.gz
  (link expires in 24h)
```

### 2.3 — Architecture

```
┌─────────────────────────────────────┐
│  Cloud Sandbox (Fly Machine)        │
│                                     │
│  ┌──────────┐    ┌───────────────┐  │
│  │ Coder    │───>│ Generated App │  │
│  │ Agent    │    │ /app/         │  │
│  └──────────┘    └───────┬───────┘  │
│                          │ tar.gz   │
│                          ▼          │
│              ┌───────────────────┐  │
│              │ Object Storage    │  │
│              │ (R2 / S3 / Tigris)│  │
│              └─────────┬─────────┘  │
└────────────────────────┼────────────┘
                         │
                         ▼
                ┌─────────────────┐
                │ Download URL    │
                │ (signed, 24h)   │
                └─────────────────┘
```

### 2.4 — Tasks

- [ ] Implement `src/packaging/archive.ts` — create tar.gz/zip from project dir
- [ ] Add exclusion list: `node_modules/`, `_agent/`, `.env`, `.git/`
- [ ] Add `--output` flag to `electric-agent new` for local archive
- [ ] Implement `src/packaging/upload.ts` — upload archive to object storage
- [ ] Generate signed download URL with 24h expiry
- [ ] Add `--host-download` flag for hosted packaging
- [ ] Test: local archive contains all necessary files, excludes secrets
- [ ] Test: hosted download URL is accessible and expires correctly

---

## Phase 3: Direct Cloud Deployment

**Goal:** `electric-agent deploy` pushes the generated app to cloud hosting. The app is live at a URL.

### 3.1 — Target architecture

```
Cloudflare Pages (free)                 Fly.io Machine (~$2-5/mo)
├── TanStack Start SSR (edge)           ├── Postgres 17 + Electric
├── Static assets (global CDN)          ├── API mutation routes
└── Client-side Electric sync           └── Caddy reverse proxy
```

**Why split:**
- Cloudflare Pages is free, globally distributed, and auto-deploys
- Postgres + Electric need a persistent server — Fly is cheapest for this
- Electric shape streams connect directly from browser to Fly

### 3.2 — Deploy command

```bash
electric-agent deploy                    # deploy to default (Cloudflare + Fly)
electric-agent deploy --provider fly     # Fly only (monolith)
electric-agent deploy --provider cf      # Cloudflare Pages only (static/SSR)
electric-agent deploy --preview          # deploy as preview (e.g., PR preview)
```

### 3.3 — Deployment flow

```
electric-agent deploy
│
├── 1. Build production bundle
│   └── pnpm build (TanStack Start produces server + client bundles)
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

### 3.4 — PR preview deployments

For projects with CI:

```yaml
# .github/workflows/preview.yml (generated into the app)
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install -g electric-agent
      - run: electric-agent deploy --preview
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

Cloudflare Pages gives per-PR preview URLs for free. Only the Fly API server needs a per-PR instance.

### 3.5 — Provider adapters

```typescript
// src/deploy/types.ts
interface DeployProvider {
  name: string
  deploy(projectDir: string, opts: DeployOptions): Promise<DeployResult>
  teardown(deployId: string): Promise<void>
}

interface DeployOptions {
  preview: boolean
  previewId?: string      // PR number or branch name
  envVars: Record<string, string>
}

interface DeployResult {
  appUrl: string
  apiUrl?: string
  electricUrl?: string
  databaseUrl?: string
  deployId: string
}
```

### 3.6 — Tasks

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
- [ ] Document: deployment prerequisites and cloud account setup

---

## Phase 4: Hosted Generation Service (Future)

**Goal:** Users visit a website, describe an app, and get a running preview — no local setup required.

### 4.1 — Architecture

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
│  Download      <──────── │  GET /api/download/:id      │ tar.gz
│  Deploy button ────────> │  POST /api/deploy/:id       │ → Phase 3 flow
```

### 4.2 — Web UI stack

- **Cloudflare Pages** — TanStack Start SSR for the marketing/app shell
- **Fly Machine** — API server (session management, SSE proxy, preview proxy)
- **Fly Machine (per-session)** — sandbox for agent execution

### 4.3 — Tasks

- [ ] Design web UI (landing page, generation form, progress view, preview)
- [ ] Implement API server (Hono on Fly)
- [ ] Implement session management (create, status, stream, download, deploy)
- [ ] Implement SSE proxy (sandbox agent → browser)
- [ ] Implement preview proxy (sandbox dev server → browser iframe)
- [ ] Implement download endpoint (sandbox → tar.gz → signed URL)
- [ ] Implement deploy trigger (calls Phase 3 flow from sandbox)
- [ ] Rate limiting, auth, abuse prevention
- [ ] Cost tracking per session (Agent SDK `maxBudgetUsd` + sandbox compute)

---

## Implementation Order

```
Phase 1 (Sandbox)     ──── Foundation. Unblocks all other phases.
    │
    ├── Phase 2 (Packaging)  ──── Quick win. Useful even without cloud.
    │
    ├── Phase 3 (Deploy)     ──── High value. Makes apps production-ready.
    │
    └── Phase 4 (Hosted)     ──── Full product. Requires all prior phases.
```

### Estimated scope

| Phase | New files | Complexity | Dependencies |
|-------|-----------|------------|--------------|
| 1 — Sandbox | ~5 | Medium | Agent SDK sandbox API, Fly Machines API |
| 2 — Packaging | ~3 | Low | Node.js tar/zip, object storage SDK |
| 3 — Deploy | ~5 | High | Fly CLI, Wrangler CLI, TanStack Start edge config |
| 4 — Hosted | ~10+ | High | Web UI, API server, SSE, preview proxy |

---

## Decision Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Default sandbox | Local OS (bubblewrap/seatbelt) | Zero config, works offline, Agent SDK native |
| First cloud provider | Fly Machines | No execution time limits, good disk I/O, cheapest for persistent DB |
| Web hosting | Cloudflare Pages | Free tier, global CDN, per-PR previews included |
| API/DB hosting | Fly.io | Postgres + Electric need persistent server; Fly is cheapest |
| Architecture | Split (CF Pages + Fly) | $2/mo vs $12/mo for 5 active PRs |
| Package format | tar.gz (default), zip (Windows) | Universal, small, no runtime dependency |

---

## Open Questions

1. **Auth for hosted service** — API keys? GitHub OAuth? Anonymous with rate limits?
2. **Persistent storage for downloads** — Tigris (Fly-native)? Cloudflare R2? S3?
3. **Cost model for hosted generation** — Free tier with limits? Pay per generation?
4. **Multi-region** — Start single-region (iad) or multi from day one?
5. **Electric Cloud** — Use Electric's managed service instead of self-hosting Electric on Fly?
