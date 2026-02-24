# CLAUDE.md

## Project

`create-electric-app` — CLI tool (`electric-agent`) that generates reactive Electric SQL + TanStack DB applications from natural-language descriptions using the Claude Agent SDK. See `ARCHITECTURE.md` for the full system design.

## Build, Test & Run

```bash
npm install                      # install dependencies
npm run build                    # compile TypeScript → dist/ + build React SPA
npm run build:server             # compile TypeScript only (no web client)
npm run build:web                # build React SPA only (Vite)
npm run dev                      # tsc --watch (server only)
npm run dev:web                  # vite dev server (React SPA hot reload)
npm run check                    # Biome lint + format check
npm run check:fix                # auto-fix Biome issues
npx tsc --noEmit                 # type-check without emitting
npm test                         # run tests (node:test runner via tsx)
npm run build:sandbox            # build Docker sandbox image
```

### Running the app

```bash
npm run serve                    # start web UI (Hono + DurableStreams + React SPA)
node dist/index.js headless      # headless NDJSON mode (used inside Docker containers)
```

### Deployment (Fly.io)

```bash
fly deploy                       # deploy server + SPA to Fly.io (uses Dockerfile.fly)
fly secrets set FLY_API_TOKEN=... DS_URL=... DS_SERVICE_ID=... DS_SECRET=...
```

- The Fly.io server runs the Node.js Hono API server and serves the React SPA.
- Sandbox runtime defaults to Sprites (`SANDBOX_RUNTIME=sprites` in `fly.toml`).
- CI auto-deploys to Fly.io on push to `main` (`.github/workflows/deploy-fly.yml`).

### Docker sandbox

```bash
npm run build:sandbox            # native build (for local Docker on macOS/ARM)
npm run push:sandbox:daytona     # build linux/amd64 + push to Daytona + create snapshot
```

- `build:sandbox` builds a **native** image for local Docker (fast on Apple Silicon).
- `push:sandbox:daytona` builds a **linux/amd64** image (Daytona requires x86), pushes it to Daytona's transient registry, and creates a snapshot. Requires `DAYTONA_API_KEY`.
- The sandbox image uses a **multi-stage Alpine build** to minimize size (~940MB vs ~1.6GB with Debian).
- Code changes require rebuilding the image for them to take effect in containers.

### Sprites (Fly.io cloud sandboxes)

Sprites are cloud micro-VMs managed via the `@fly/sprites` SDK and the `sprite` CLI.

**CLI usage** (installed at `~/.local/bin/sprite`):
```bash
sprite list                          # list all active sprites
sprite destroy -force <sprite-name>  # destroy a sprite (flags BEFORE the name)
sprite exec <sprite-name> -- <cmd>   # execute a command in a sprite
```

**Important**: The `sprite` CLI uses Go-style flags — flags must come **before** positional arguments (e.g., `sprite destroy -force ea-abc123`, NOT `sprite destroy ea-abc123 -force`).

**SDK gotchas** (`@fly/sprites` JS SDK):
- `sprite.exec(command)` splits the command string by whitespace (`command.trim().split(/\s+/)`), so **all shell features are broken** (pipes, redirects, `&&`, quoted args, heredocs).
- Always use `sprite.execFile("bash", ["-c", "..."])` for anything needing shell interpretation.
- `sprite.createSession()` forces `tty: true`, which merges stdout/stderr and adds terminal control characters — avoid for structured output (NDJSON).
- Sprite names follow the pattern `ea-{sessionId first 12 chars}`.
- Node.js in sprites uses nvm at `/.sprite/languages/node/nvm/`. The npm global bin is NOT in the default PATH — commands must source `/etc/profile.d/npm-global.sh` first.

### Releasing (npm)

Publishing is managed by [Changesets](https://github.com/changesets/changesets) with automated CI via GitHub Actions.

**Automated workflow (recommended):**
1. Add a changeset to your PR: `npx changeset` (select bump type + summary)
2. Merge the PR to `main`
3. The `release.yml` workflow creates a "chore: version packages" PR (bumps version, updates CHANGELOG)
4. Merge the version PR → workflow publishes to npm via OIDC trusted publishing

**Manual workflow:** `npx changeset version && npm run release` (requires `npm login --auth-type=web`)

**What needs redeploying after a new npm release:**
- **Fly.io (server + SPA)**: Only redeploy if you changed server code (`src/web/`), the React SPA (`src/web/client/`), or bootstrap logic (`sprites-bootstrap.ts`). The Fly.io image runs the server, not the agent.
- **Sprites**: Nothing — sprites auto-pick up new npm versions. The bootstrap checkpoint includes the package version (`bootstrapped:X.Y.Z`), so a new release invalidates old checkpoints and triggers a fresh `npm install -g electric-agent`.
- **Docker sandbox image**: Rebuild (`npm run build:sandbox`) if agent code changed. The agent is baked into the image.

## Verification Checklist

Before committing, always run:

1. `npm run check:fix` — auto-fix Biome lint + format issues (covers all files under `src/`, including `src/web/client/`)
2. `npm run check` — verify no remaining lint or format errors (this is what CI runs)
3. `npx tsc --noEmit` — type-check passes
4. `npm run build` — full build succeeds (TypeScript + Vite)
5. `npm test` — tests pass

**Important**: `npm run check` / `check:fix` runs Biome on **all** of `src/`, including the web client (`src/web/client/**`). CI will fail if any file has formatting or lint issues, so always run `check:fix` before committing.

## Architecture

See `ARCHITECTURE.md` for the complete architecture reference. Keep it updated when making structural changes — adding/removing agents, tools, hooks, engine events, API routes, or UI components.

### Source Layout

```
src/
├── index.ts                     # CLI entry point (commander)
├── cli/                         # Command implementations
│   ├── headless.ts              # NDJSON stdin/stdout mode (runs inside containers)
│   └── serve.ts                 # Web UI server startup
├── engine/                      # Shared orchestration (used by CLI + web)
│   ├── events.ts                # EngineEvent union type — single source of truth
│   ├── orchestrator.ts          # runNew() + runIterate() with callback-driven I/O
│   ├── message-parser.ts        # SDK message → EngineEvent[] conversion
│   └── headless-adapter.ts      # OrchestratorCallbacks for NDJSON stdin/stdout
├── agents/                      # Agent execution via Claude Agent SDK
│   ├── clarifier.ts             # Description evaluation + project name inference
│   ├── planner.ts               # Planner agent (Sonnet) — generates PLAN.md
│   ├── coder.ts                 # Coder agent (Sonnet) — executes plan tasks
│   ├── git-agent.ts             # Git agent (Haiku) — commits, push, PRs
│   └── prompts.ts               # System prompt builders for all agents
├── tools/                       # Custom MCP tools
│   ├── server.ts                # electric-agent-tools MCP server (build + playbooks)
│   ├── git-server.ts            # git-tools MCP server (9 git operations)
│   ├── git.ts                   # Git tool implementations
│   ├── build.ts                 # build tool — pnpm build + check + test
│   └── playbook.ts              # read_playbook + list_playbooks tools
├── hooks/                       # Agent SDK guardrail hooks
│   ├── index.ts                 # Hook registry (coder + planner configs)
│   ├── guardrail-inject.ts      # SessionStart: inject guardrails + ARCHITECTURE.md
│   ├── write-protection.ts      # Block writes to config files
│   ├── import-validation.ts     # Catch hallucinated imports
│   ├── migration-validation.ts  # Auto-append REPLICA IDENTITY FULL
│   ├── dependency-guard.ts      # Prevent dependency removal
│   └── schema-consistency.ts    # Warn on bad Zod patterns
├── git/                         # Server-side git helpers (used by web server)
│   └── index.ts                 # gitStatus, ghListAccounts, ghListRepos, etc.
├── scaffold/                    # Project scaffolding
│   └── index.ts                 # KPB clone + template overlay + dep merge + install
├── working-memory/              # Agent state persistence
│   ├── session.ts               # Session state (phase, task, build status)
│   └── errors.ts                # Error log with dedup detection
├── progress/                    # CLI output
│   └── reporter.ts              # Color-coded progress logging
└── web/                         # Web UI server + client
    ├── server.ts                # Hono API server (REST + static SPA)
    ├── infra.ts                 # DurableStream server lifecycle
    ├── gate.ts                  # Promise-based gate management
    ├── sessions.ts              # Session index (JSON file)
    ├── streams.ts               # Durable Streams connection config
    ├── sandbox/                 # Container management
    │   ├── types.ts             # SandboxProvider interface + types
    │   ├── docker.ts            # DockerSandboxProvider implementation
    │   ├── daytona.ts           # DaytonaSandboxProvider (cloud, snapshot-based)
    │   ├── daytona-registry.ts  # Transient registry push + snapshot lifecycle
    │   ├── daytona-push.ts      # CLI: build amd64 + push + create snapshot
    │   ├── sprites.ts           # SpritesSandboxProvider (Fly.io Sprites)
    │   ├── sprites-bootstrap.ts # Sprites bootstrap + checkpoint restore
    │   └── index.ts             # Re-exports
    ├── bridge/                  # Sandbox communication bridges
    │   ├── types.ts             # SessionBridge interface
    │   ├── hosted.ts            # HostedStreamBridge (Durable Streams)
    │   ├── docker-stdio.ts      # DockerStdioBridge (stdin/stdout)
    │   ├── daytona.ts           # DaytonaSessionBridge
    │   ├── sprites.ts           # SpritesStdioBridge (Sprites SDK sessions)
    │   └── index.ts             # Re-exports
    └── client/                  # React SPA (built with Vite, deployed with server)
        ├── index.html
        ├── vite.config.ts
        └── src/
            ├── main.tsx
            ├── router.tsx       # / (HomePage) and /session/:id (SessionPage)
            ├── hooks/
            │   └── useSession.ts   # Durable stream subscription + event reducer
            ├── components/
            │   ├── Console.tsx     # Scrolling event log
            │   ├── ConsoleEntry.tsx
            │   ├── ToolExecution.tsx
            │   ├── GatePrompt.tsx  # All gate UI components
            │   ├── PromptInput.tsx
            │   ├── Sidebar.tsx
            │   ├── FileTree.tsx
            │   ├── FileViewer.tsx
            │   ├── RightPanel.tsx
            │   ├── GitControls.tsx
            │   ├── Settings.tsx
            │   └── Markdown.tsx
            ├── layouts/
            │   └── AppShell.tsx    # Sidebar + context provider
            ├── pages/
            │   ├── HomePage.tsx
            │   └── SessionPage.tsx
            └── lib/
                ├── api.ts          # fetch wrappers for /api/*
                └── event-types.ts  # Client-side EngineEvent + ConsoleEntry types
```

## Key Patterns

- **Callback-driven I/O**: `OrchestratorCallbacks` in `orchestrator.ts` abstracts all output and decision points. The engine never knows if it's running in CLI, web, or test mode.
- **NDJSON protocol**: Container and server communicate via stdin/stdout newline-delimited JSON. First line is config, subsequent lines are gate responses or new commands.
- **Promise-based gates**: Both headless (`StdinReader.waitFor()`) and web (`gate.ts createGate()`) use Promises that block until an external event resolves them.
- **Durable Streams**: File-backed event log (`@durable-streams/server`) enables real-time SSE push, reconnect catch-up, and full session replay.
- **Hook interception**: Guardrail hooks intercept tool calls at `PreToolUse`/`PostToolUse` transparently. Return `{ hookSpecificOutput: { permissionDecision: "deny" } }` to block.
- **MCP Tools**: Created via `tool()` + `createSdkMcpServer()`. Referenced as `mcp__<server>__<tool>` in `allowedTools`.
- **Agent SDK**: Uses `query()` with async generators. Planner uses Sonnet (10 turns), Coder uses Sonnet (200 turns, $25), Git Agent uses Haiku (5 turns, $0.25).
- **Session resumption**: Coder returns `session_id` from SDK, stored and passed as `{ resume: sessionId }` on subsequent runs.

## Conventions

- **Biome 2.2.4** for linting/formatting — tabs, double quotes, no semicolons
- **No `any`** — use `Record<string, unknown>` for untyped SDK inputs
- Template literals preferred over string concatenation
- `const` over `let` where possible
- Imports sorted alphabetically (enforced by Biome)
- **Event types must stay in sync**: `src/engine/events.ts` (server) and `src/web/client/src/lib/event-types.ts` (client) define the same `EngineEvent` union. When adding/removing event types, update both files plus the `useSession.ts` reducer and any `GatePrompt.tsx` gate components.

## Adding New Features

### New agent
1. Create `src/agents/<name>.ts` following the pattern in `git-agent.ts` (simplest) or `coder.ts` (full-featured)
2. Add system prompt builder to `src/agents/prompts.ts`
3. If it needs tools, create MCP server in `src/tools/`
4. Wire into `orchestrator.ts` or `headless.ts` depending on when it runs

### New MCP tool
1. Create tool function in `src/tools/<name>.ts` using `tool()` from the Agent SDK
2. Add to an existing MCP server (or create a new one via `createSdkMcpServer()`)
3. Add the `mcp__<server>__<tool>` name to the agent's `allowedTools` array

### New engine event
1. Add type to `src/engine/events.ts`
2. Add matching type to `src/web/client/src/lib/event-types.ts`
3. Handle in `src/web/client/src/hooks/useSession.ts` `processEvent()` reducer
4. If it's a gate event, add UI component in `GatePrompt.tsx`

### New guardrail hook
1. Create hook in `src/hooks/<name>.ts`
2. Register in `src/hooks/index.ts` under the appropriate agent config and matcher

### New API route
1. Add to `src/web/server.ts` in `createApp()`
2. Add client wrapper in `src/web/client/src/lib/api.ts`

## CI / GitHub Actions Secrets

The following secrets are configured on the GitHub repository (set via `gh secret set`):

| Secret | Purpose |
|---|---|
| `DOCKER_HUB_USER` | Docker Hub username |
| `DOCKER_HUB_TOKEN` | Docker Hub access token |
| `DAYTONA_API_KEY` | Daytona cloud sandbox API key |
| `DAYTONA_API_URL` | Daytona API endpoint |
| `DS_URL` | Durable Streams (Electric) API URL |
| `DS_SERVICE_ID` | Durable Streams service ID |
| `DS_SECRET` | Durable Streams JWT secret |
| `GH_TOKEN` | GitHub PAT (used by agents for git operations) |
| `FLY_API_TOKEN` | Fly.io deploy token + Sprites sandbox API |

## Common Gotchas

- **EngineEvent sync**: Forgetting to update client-side `event-types.ts` when changing `events.ts` causes silent type mismatches at runtime.
- **Sandbox image staleness**: Code changes require rebuilding the Docker image (`npm run build:sandbox` for local, `npm run push:sandbox:daytona` for Daytona). Easy to forget.
- **Sandbox platform**: `build:sandbox` builds native (ARM on Mac), `push:sandbox:daytona` builds linux/amd64. Daytona will fail with "no matching manifest for linux/amd64" if you push an ARM image.
- **Daytona snapshot caching**: `DaytonaSandboxProvider` caches the snapshot name in-memory after first resolve. Restart the server to pick up a new snapshot after re-pushing.
- **Gate categories**: Server-side gates (`checkpoint`, `publish`, `infra_config`, `repo_setup`) resolve in-process. Container-forwarded gates (`clarification`, `approval`, `continue`, `revision`) are written to container stdin. Adding a new gate requires choosing the right category and updating the `serverGates` set in `server.ts`.
- **Hook denial format**: Must return `{ hookSpecificOutput: { permissionDecision: "deny" } }` — not just a boolean.
- **`initGit` in scaffold**: The scaffold's `skipGit` option controls whether git init runs during scaffolding. In headless/sandbox mode, git is initialized early in `headless.ts` before `runNew()`.
- **Sprites `exec()` splits by whitespace**: Never use `sprite.exec()` for commands with shell features. Use `sprite.execFile("bash", ["-c", "..."])` instead. This applies to the SDK, not the CLI.
- **Sprites CLI flag order**: The `sprite` CLI uses Go-style flags — flags must come before positional arguments (e.g., `sprite destroy -force <name>`).
- **Sprites PATH**: npm global binaries (like `electric-agent`) are not in PATH by default. Always source `/etc/profile.d/npm-global.sh` before running them.
- **GitHub token flow**: API keys and GH tokens are stored in the browser's localStorage, sent to the server via POST body (`ghToken` field) or `X-GH-Token` header (GET requests), and passed explicitly to `gh` CLI functions. Do not rely on ambient `GH_TOKEN` env vars on the server.
