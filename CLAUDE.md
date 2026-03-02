# CLAUDE.md

## Project

`electric-agent` — pnpm workspaces monorepo containing three packages that together generate reactive Electric SQL + TanStack DB applications from natural-language descriptions using the Claude Agent SDK. See `ARCHITECTURE.md` for the full system design.

### Packages

| Package | Description |
|---|---|
| `@electric-agent/protocol` | Shared event types (`EngineEvent`) and helpers — the contract between agent and studio |
| `@electric-agent/studio` | General-purpose agent platform — web UI (Hono + React SPA), sandbox providers, session bridges |
| `@electric-agent/agent` | Electric SQL code generation agent + CLI (`electric-agent`) |

## Build, Test & Run

```bash
pnpm install                     # install all workspace dependencies
pnpm run build                   # build all packages (protocol → studio → agent)
pnpm run typecheck               # type-check all packages
pnpm run check                   # Biome lint + format check
pnpm run check:fix               # auto-fix Biome issues
pnpm run test                    # run all tests across packages
```

### Per-package commands

```bash
pnpm --filter @electric-agent/protocol run build
pnpm --filter @electric-agent/studio run build        # tsc + vite build (React SPA)
pnpm --filter @electric-agent/studio run build:server  # tsc only (no web client)
pnpm --filter @electric-agent/studio run dev:web       # vite dev server (hot reload)
pnpm --filter @electric-agent/agent run build
pnpm --filter @electric-agent/agent run dev            # tsc --watch
pnpm --filter @electric-agent/agent run test
pnpm --filter @electric-agent/studio run test
```

### Running the app

The server requires `DS_URL`, `DS_SERVICE_ID`, and `DS_SECRET` env vars (Durable Streams credentials). Set them in a `.env` file at the project root or export them before starting.

```bash
pnpm --filter @electric-agent/agent run serve    # start web UI + Caddy HTTPS proxy
node packages/agent/dist/index.js headless       # headless NDJSON mode (used inside Docker containers)
```

- **`SANDBOX_RUNTIME=docker`** (default) — runs sessions in Docker containers. The server must run on the host (not inside a container) so it can access the Docker daemon.
- **`SANDBOX_RUNTIME=sprites`** — uses Fly.io Sprites cloud VMs. Requires `FLY_API_TOKEN`.
- **`SANDBOX_RUNTIME=daytona`** — uses Daytona cloud sandboxes. Requires `DAYTONA_API_KEY`.

**Claude Code hook integration:** To stream Claude Code events into the studio UI, install the hook forwarder in your project:
```bash
cd <your-project>
curl -s http://localhost:4400/api/hooks/setup | bash
```
This installs `.claude/hooks/forward.sh` and configures `.claude/settings.local.json` in the current project directory. After installation, running `claude` in the project will automatically stream events to the studio. Sessions correlate via `transcript_path` — resume continues the same session, `/clear` starts a new one.

**Caddy (HTTP/2 reverse proxy):** `pnpm serve` auto-starts Caddy if installed, proxying `https://localhost:4443` → `http://127.0.0.1:4400`. HTTP/2 is required for concurrent SSE streams (registry + per-session). Install with `brew install caddy`. Accept the self-signed cert on first visit. If Caddy is not installed, the server falls back to plain HTTP on port 4400 (limited to ~6 concurrent SSE connections per browser).

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

**IMPORTANT: You MUST run these checks before every commit. CI will reject PRs that fail any of these.**

```bash
pnpm run check:fix               # 1. Auto-fix Biome lint + format issues
pnpm run check                   # 2. Verify zero remaining lint/format errors
pnpm run typecheck               # 3. Type-check all packages
pnpm run build                   # 4. Full build succeeds (TypeScript + Vite)
pnpm run test                    # 5. Tests pass
```

**Build order matters**: protocol must build before studio (needs declaration files), and studio must build before agent. `pnpm run build` handles this automatically via workspace dependency ordering.

**Important**: `pnpm run check` / `check:fix` runs Biome on **all** of `packages/`, including the web client (`packages/studio/client/**`). CI will fail if any file has formatting or lint issues, so always run `check:fix` before committing. The `check` output must show **zero errors** (warnings are acceptable for pre-existing `noNonNullAssertion` in tests/templates only).

## Architecture

See `ARCHITECTURE.md` for the complete architecture reference. Keep it updated when making structural changes — adding/removing agents, tools, hooks, engine events, API routes, or UI components.

### Source Layout

```
packages/
├── protocol/                        # @electric-agent/protocol
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── events.ts                # EngineEvent union type — single source of truth
│       └── index.ts                 # Re-exports
├── studio/                          # @electric-agent/studio
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── server.ts                # Hono API server (REST + static SPA)
│   │   ├── gate.ts                  # Promise-based gate management
│   │   ├── sessions.ts              # Session index (JSON file)
│   │   ├── streams.ts               # Durable Streams connection config
│   │   ├── electric-api.ts          # Electric SQL provisioning API
│   │   ├── git.ts                   # GitHub listing fns (ghListAccounts, etc.)
│   │   ├── project-utils.ts         # resolveProjectDir utility
│   │   ├── index.ts                 # Barrel exports
│   │   ├── sandbox/                 # Container management providers
│   │   │   ├── types.ts             # SandboxProvider interface
│   │   │   ├── docker.ts            # DockerSandboxProvider
│   │   │   ├── daytona.ts           # DaytonaSandboxProvider
│   │   │   ├── daytona-registry.ts  # Transient registry + snapshots
│   │   │   ├── sprites.ts           # SpritesSandboxProvider
│   │   │   ├── sprites-bootstrap.ts # Sprites bootstrap + checkpoint
│   │   │   └── index.ts             # Re-exports
│   │   └── bridge/                  # Session communication bridges
│   │       ├── types.ts             # SessionBridge interface
│   │       ├── hosted.ts            # HostedStreamBridge (Durable Streams)
│   │       ├── docker-stdio.ts      # DockerStdioBridge (stdin/stdout)
│   │       ├── daytona.ts           # DaytonaSessionBridge
│   │       ├── sprites.ts           # SpritesStdioBridge
│   │       └── index.ts             # Re-exports
│   ├── client/                      # React SPA (Vite, own build)
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── src/
│   │       ├── main.tsx
│   │       ├── router.tsx
│   │       ├── hooks/useSession.ts
│   │       ├── components/          # Console, GatePrompt, FileTree, etc.
│   │       ├── layouts/AppShell.tsx
│   │       ├── pages/               # HomePage, SessionPage
│   │       └── lib/
│   │           ├── api.ts           # fetch wrappers for /api/*
│   │           └── event-types.ts   # Re-exports EngineEvent from protocol
│   └── tests/
│       ├── hook-bridge.test.ts
│       ├── streams.test.ts
│       ├── sandbox.test.ts
│       ├── sprites.test.ts
│       ├── claim-api.test.ts
│       └── local-stream-server.ts   # Test helper
└── agent/                           # @electric-agent/agent
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── index.ts                 # CLI entry point (commander)
    │   ├── cli/
    │   │   ├── headless.ts          # NDJSON stdin/stdout mode
    │   │   └── serve.ts             # Web UI server startup
    │   ├── engine/
    │   │   ├── orchestrator.ts      # runNew() + runIterate()
    │   │   ├── message-parser.ts    # SDK message → EngineEvent[]
    │   │   ├── headless-adapter.ts  # OrchestratorCallbacks for NDJSON
    │   │   └── stream-adapter.ts    # OrchestratorCallbacks for streams
    │   ├── agents/                  # Clarifier, Planner, Coder, Git Agent
    │   ├── tools/                   # MCP tool servers
    │   ├── hooks/                   # Agent SDK guardrail hooks
    │   ├── scaffold/                # Project scaffolding
    │   ├── working-memory/          # Agent state persistence
    │   ├── progress/                # CLI progress reporting
    │   └── git/                     # Local git operations
    ├── playbooks/                   # Runtime asset
    ├── template/                    # Runtime asset
    └── tests/
        ├── scaffold.test.ts
        ├── bridge.test.ts
        ├── e2e-docker.test.ts
        └── e2e-daytona.test.ts
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
- **Workspace dependency graph**: `protocol` → `studio` → `agent`. Studio imports types from protocol; agent imports from both.

## Conventions

- **pnpm workspaces** — `workspace:*` for internal package dependencies
- **Biome 2.2.4** for linting/formatting — tabs, double quotes, no semicolons
- **No `any`** — use `Record<string, unknown>` for untyped SDK inputs
- Template literals preferred over string concatenation
- `const` over `let` where possible
- Imports sorted alphabetically (enforced by Biome)
- **Changesets** for versioning — each PR should include a changeset (`pnpm exec changeset`)
- **Event types**: `EngineEvent` is defined in `@electric-agent/protocol`. Client re-exports it. When adding/removing event types, update the protocol package, the `useSession.ts` reducer, and any `GatePrompt.tsx` gate components.

## Claude Code App Generation

When Claude Code is used to generate Electric SQL apps (via hooks or bridges), the `/create-app` skill replicates the electric-agent's multi-phase pipeline:

1. **Clarification** — evaluates description completeness, asks targeted questions if vague
2. **Planning** — generates PLAN.md with complete data model + phased tasks, presents for approval
3. **Data model validation gate** — writes schema + zod-schemas + tests, runs `pnpm test` before proceeding
4. **Code generation** — collections, API routes, UI, build, final tests, ARCHITECTURE.md

**Auto-triggering**: When a user prompt describes creating a new app (e.g., "create a kanban board", "build a todo app with categories"), Claude Code should invoke `/create-app <description>` to follow the structured pipeline instead of coding ad-hoc.

The skill is defined in `.claude/skills/create-app/SKILL.md`. For scaffolded projects, copy it to the project's `.claude/skills/` directory or include it in the hook setup script.

## Adding New Features

### New agent
1. Create `packages/agent/src/agents/<name>.ts` following the pattern in `git-agent.ts` (simplest) or `coder.ts` (full-featured)
2. Add system prompt builder to `packages/agent/src/agents/prompts.ts`
3. If it needs tools, create MCP server in `packages/agent/src/tools/`
4. Wire into `orchestrator.ts` or `headless.ts` depending on when it runs

### New MCP tool
1. Create tool function in `packages/agent/src/tools/<name>.ts` using `tool()` from the Agent SDK
2. Add to an existing MCP server (or create a new one via `createSdkMcpServer()`)
3. Add the `mcp__<server>__<tool>` name to the agent's `allowedTools` array

### New engine event
1. Add type to `packages/protocol/src/events.ts`
2. Handle in `packages/studio/client/src/hooks/useSession.ts` `processEvent()` reducer
3. If it's a gate event, add UI component in `GatePrompt.tsx`

### New guardrail hook
1. Create hook in `packages/agent/src/hooks/<name>.ts`
2. Register in `packages/agent/src/hooks/index.ts` under the appropriate agent config and matcher

### New API route
1. Add to `packages/studio/src/server.ts` in `createApp()`
2. Add client wrapper in `packages/studio/client/src/lib/api.ts`

### New sandbox provider
1. Create provider in `packages/studio/src/sandbox/<name>.ts` implementing `SandboxProvider`
2. Add subpath export to `packages/studio/package.json`
3. Wire into `packages/agent/src/cli/serve.ts` runtime selection

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

- **Build order**: Protocol must be built before studio can typecheck (workspace resolution needs `dist/`). Use `pnpm run build` which respects dependency order.
- **EngineEvent sync**: `EngineEvent` lives in `@electric-agent/protocol`. Client re-exports it. When changing events, rebuild protocol before testing other packages.
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
- **Studio subpath exports**: Studio exposes `./server`, `./streams`, `./sessions`, `./sandbox`, `./sandbox/*`, `./bridge`. Import from specific subpaths, not the barrel `@electric-agent/studio`.
