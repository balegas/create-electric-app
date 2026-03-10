# Electric Agent Documentation

Electric Agent is a multi-agent platform that generates reactive [Electric SQL](https://electric-sql.com/) + [TanStack DB](https://tanstack.com/db) applications from natural-language descriptions, using Claude as the code-generation engine.

```bash
electric-agent new "a project management app with boards and tasks"
```

One command scaffolds a full-stack reactive app — Drizzle schema, Postgres migrations, Electric sync, TanStack DB collections, API routes, and a React UI — all running inside an isolated sandbox.

## What Electric Agent Does

1. **Generates apps from plain English.** Describe what you want; the agent plans a data model, writes the code, runs migrations, and starts a dev server.
2. **Runs agents in sandboxes.** Each session gets its own isolated environment (Docker, Fly.io Sprites, or Daytona) so generated code never touches your host machine.
3. **Streams everything in real time.** Every tool call, plan decision, and build result is streamed to a web UI via persistent event logs (Durable Streams).
4. **Supports multi-agent collaboration.** Multiple Claude agents can join a shared room, communicate via a structured messaging protocol, and work on different aspects of a project simultaneously.

## Monorepo Packages

| Package | Description |
|---|---|
| [`@electric-agent/protocol`](./protocol.md) | Shared event types (`EngineEvent`) and helpers — the contract between agent and studio |
| `@electric-agent/studio` | Web UI server, sandbox providers, session bridges, and room messaging |
| `@electric-agent/agent` | CLI entry point, project scaffolding, and code-generation orchestration |

```
packages/
├── protocol/   # Event types shared across packages
├── studio/     # Hono server, React SPA, sandbox management, bridges
└── agent/      # CLI, scaffolding, playbooks, project template
```

## Reference Docs

| Document | What it covers |
|---|---|
| [Protocol & Events](./protocol.md) | The `EngineEvent` type system — every event the agent can emit, gate mechanics, and streaming |
| [Multi-Agent Rooms](./multi-agent.md) | Room messaging protocol, agent roles, discovery prompts, and gating |
| [Sandboxes & Bridges](./sandboxes-and-bridges.md) | Sandbox providers (Docker, Sprites, Daytona), bridge modes, and session lifecycle |
| [Security & Authentication](./security.md) | Session tokens, room tokens, hook authentication, and endpoint protection |
| [Architecture](./architecture.md) | System overview, request lifecycle, data flow, and key design decisions |
| [Publishing](./publishing.md) | npm releases via Changesets, OIDC trusted publishing, and CI workflow |

## Tech Stack

- [Electric SQL](https://electric-sql.com/) — real-time Postgres sync
- [TanStack DB](https://tanstack.com/db) — reactive collections with optimistic mutations
- [TanStack Start](https://tanstack.com/start) — full-stack React framework
- [Drizzle ORM](https://orm.drizzle.team/) — type-safe Postgres schema and queries
- [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) — agentic code generation
- [Durable Streams](https://github.com/durable-streams/durable-streams) — persistent event streaming
- [Hono](https://hono.dev/) — lightweight HTTP server
- [Vite](https://vite.dev/) + [React](https://react.dev/) — web UI client
