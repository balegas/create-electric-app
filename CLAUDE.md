# Electric Agent — Development Guide

## Project Overview

Electric Agent is a multi-agent platform that generates reactive Electric SQL + TanStack DB applications from natural language. It is a pnpm monorepo with three packages:

| Package | Path | Description |
|---|---|---|
| `@electric-agent/protocol` | `packages/protocol/` | Shared event types (`EngineEvent`) — the contract between agent and studio |
| `@electric-agent/studio` | `packages/studio/` | Hono server, React SPA, sandbox providers, session bridges, room messaging |
| `@electric-agent/agent` | `packages/agent/` | CLI entry point, project scaffolding, playbooks, template assets |

## Reference Documentation

Read the relevant docs **before** making changes to unfamiliar areas:

| Document | Path | When to read |
|---|---|---|
| [Protocol & Events](docs/protocol.md) | `docs/protocol.md` | Modifying event types, gate mechanics, streaming |
| [Multi-Agent Rooms](docs/multi-agent.md) | `docs/multi-agent.md` | Working on room messaging, agent roles, or gating |
| [Sandboxes & Bridges](docs/sandboxes-and-bridges.md) | `docs/sandboxes-and-bridges.md` | Changing sandbox providers or bridge implementations |
| [Security](docs/security.md) | `docs/security.md` | Modifying authentication, tokens, or endpoint protection |
| [Architecture](docs/architecture.md) | `docs/architecture.md` | Understanding system design, request lifecycle, data flow |
| [Publishing](docs/publishing.md) | `docs/publishing.md` | Releasing to npm, changeset workflow |

## Build & Lint Commands

```bash
pnpm run build        # build all packages (protocol → studio → agent)
pnpm run typecheck    # type-check all packages
pnpm run check        # biome lint + format check (MUST pass before committing)
pnpm run check:fix    # auto-fix biome lint/format issues
pnpm run test         # run all tests
```

### Per-Package

```bash
pnpm --filter @electric-agent/protocol run build
pnpm --filter @electric-agent/studio run build
pnpm --filter @electric-agent/studio run test
pnpm --filter @electric-agent/agent run build
pnpm --filter @electric-agent/agent run test
```

## Pre-Commit Checklist

Before every commit, you MUST:

1. **Run lint**: `pnpm run check` — fix any issues with `pnpm run check:fix`
2. **Run tests**: `pnpm run test` — ensure nothing is broken
3. **Create a changeset** (see below)

Do NOT commit code that fails lint or tests.

## Changesets (REQUIRED)

Every commit that changes package code MUST include a changeset. This is how versions and changelogs are managed.

### Creating a Changeset

Create a markdown file in `.changeset/` with a short kebab-case name:

```bash
# Example: .changeset/fix-session-token-validation.md
```

File format:

```markdown
---
"@electric-agent/studio": patch
---

Fix session token validation for SSE reconnection.
```

### Bump Types

| Type | When to use |
|---|---|
| `patch` | Bug fixes, small improvements |
| `minor` | New features, non-breaking additions |
| `major` | Breaking changes to public API or event types |

### Rules

- Only list packages that were **actually modified** in the changeset
- One changeset per logical change (a PR may have multiple changesets)
- Write a clear, concise description of **what changed and why**
- If you modified files in multiple packages, list all affected packages in the same changeset

### Example: Multi-Package Changeset

```markdown
---
"@electric-agent/protocol": minor
"@electric-agent/studio": minor
---

Add agent_message event type for room messaging protocol.
```

## Code Style

- **Formatter/Linter**: Biome (configured in `biome.json` — do NOT modify)
- **Import style**: Named imports, no default exports unless required by framework
- **TypeScript**: Strict mode, no `any` unless unavoidable

## Key Directories

```
packages/
├── protocol/src/          # Event type definitions (events.ts)
├── studio/
│   ├── src/               # Hono server, bridges, sandbox providers, room router
│   ├── client/src/        # React SPA (pages, components, hooks)
│   └── tests/             # Server-side tests
└── agent/
    ├── src/               # CLI, scaffolding, serve command
    ├── playbooks/         # Runtime playbook assets
    ├── template/          # Project template files (overlaid on scaffolded apps)
    └── tests/             # Agent tests
```

## Running the Server Locally

```bash
cp .env.example .env       # fill in DS_URL, DS_SERVICE_ID, DS_SECRET
pnpm run build
pnpm run serve             # http://127.0.0.1:4400
```

For development with hot reload, run in separate terminals:

```bash
pnpm --filter @electric-agent/agent run dev     # tsc --watch
pnpm run serve                                  # backend (port 4400)
pnpm --filter @electric-agent/studio run dev:web # vite HMR (port 4401)
```

## Environment Variables

See `.env.example` for all available variables. The required ones are:

| Variable | Purpose |
|----------|---------|
| `DS_URL` | Durable Streams API URL |
| `DS_SERVICE_ID` | Durable Streams service ID |
| `DS_SECRET` | JWT secret (also used for HMAC token derivation) |

## Sandbox Environment Notes

When running inside a cloud sandbox (Fly.io Sprite), these constraints apply:

- Only **port 8080** is externally accessible
- No Docker or local database available
- `DATABASE_URL` points to a remote Postgres (Neon)
- npm global binaries require: `source /etc/profile.d/npm-global.sh`
