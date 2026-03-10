# electric-agent

A multi-agent platform that generates reactive [Electric SQL](https://electric-sql.com/) + [TanStack DB](https://tanstack.com/db) applications from natural-language descriptions, powered by Claude.

```bash
electric-agent new "a project management app with boards and tasks"
```

For full documentation, see [docs/](./docs/index.md).

## Prerequisites

- **Node.js** >= 24
- **pnpm** >= 10
- **Docker** — for sandbox mode and generated projects
- **Anthropic API key** — `ANTHROPIC_API_KEY` env var, or `claude login` on macOS
- **GitHub CLI** (`gh`) — optional, for GitHub integration (publish, PR, resume)

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/balegas/create-electric-app.git
cd create-electric-app
pnpm install
```

### 2. Configure environment

Copy the example env file and fill in your credentials:

```bash
cp .env.example .env
```

**Required variables:**

| Variable | Purpose |
|----------|---------|
| `DS_URL` | Durable Streams API URL |
| `DS_SERVICE_ID` | Durable Streams service ID |
| `DS_SECRET` | Durable Streams JWT secret |

**Optional variables:**

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude API key (or use `claude login` on macOS) |
| `GH_TOKEN` | GitHub PAT for repo/PR operations |

### 3. Build

```bash
pnpm run build       # build all packages (protocol → studio → agent)
```

### 4. Start the web UI

```bash
pnpm run serve       # http://127.0.0.1:4400
```

With Docker sandboxing:

```bash
pnpm run build:sandbox          # one-time: build sandbox Docker image
pnpm run serve -- --sandbox     # start with sandbox mode
```

## Monorepo Packages

| Package | npm | Description |
|---|---|---|
| `@electric-agent/protocol` | [![npm](https://img.shields.io/npm/v/@electric-agent/protocol)](https://www.npmjs.com/package/@electric-agent/protocol) | Shared event types (`EngineEvent`) and helpers |
| `@electric-agent/studio` | [![npm](https://img.shields.io/npm/v/@electric-agent/studio)](https://www.npmjs.com/package/@electric-agent/studio) | Web UI, sandbox providers, session bridges |
| `@electric-agent/agent` | [![npm](https://img.shields.io/npm/v/@electric-agent/agent)](https://www.npmjs.com/package/@electric-agent/agent) | CLI, code generation agent, project scaffolding |

## Development

### Common Commands

```bash
pnpm run build        # build all packages
pnpm run typecheck    # type-check all packages
pnpm run check        # biome lint + format check
pnpm run check:fix    # auto-fix biome issues
pnpm run test         # run all tests
```

### Per-Package Commands

```bash
pnpm --filter @electric-agent/protocol run build
pnpm --filter @electric-agent/studio run build
pnpm --filter @electric-agent/studio run dev:web       # vite dev (hot reload)
pnpm --filter @electric-agent/agent run build
pnpm --filter @electric-agent/agent run dev            # tsc --watch
pnpm --filter @electric-agent/agent run test
```

### Web UI Development (Hot Reload)

Run in separate terminals:

```bash
pnpm --filter @electric-agent/agent run dev     # tsc --watch
pnpm run serve                                  # backend (port 4400)
pnpm --filter @electric-agent/studio run dev:web # vite HMR (port 4401)
```

Open http://127.0.0.1:4401 for development with hot reload.

### Releasing

This project uses [Changesets](https://github.com/changesets/changesets) for versioning and publishing. See [docs/publishing.md](./docs/publishing.md) for the full workflow.

```bash
pnpm exec changeset          # add a changeset to your PR
# merge to main → CI creates version PR → merge → CI publishes to npm
```

## CLI Reference

```bash
electric-agent new <description>          # create a new app
electric-agent new <desc> --name my-app   # custom project name
electric-agent new <desc> --no-approve    # skip plan approval
electric-agent iterate                    # iterate on existing app
electric-agent headless                   # NDJSON stdin/stdout (CI/Docker)
electric-agent serve                      # web UI (port 4400)
electric-agent serve --sandbox            # web UI with Docker sandboxing
electric-agent up                         # start Docker + migrations + dev
electric-agent down                       # stop all services
electric-agent status                     # show project progress
```

## Documentation

| Document | What it covers |
|---|---|
| [Documentation Index](./docs/index.md) | Overview and links to all docs |
| [Protocol & Events](./docs/protocol.md) | Event types, gate mechanics, streaming |
| [Multi-Agent Rooms](./docs/multi-agent.md) | Room messaging, agent roles, gating |
| [Sandboxes & Bridges](./docs/sandboxes-and-bridges.md) | Sandbox providers, bridge modes |
| [Security](./docs/security.md) | Authentication, tokens, endpoint protection |
| [Architecture](./docs/architecture.md) | System design, data flow, CLI |
| [Publishing](./docs/publishing.md) | npm releases, changesets, CI |
