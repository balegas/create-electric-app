# Cloud Runtimes Research

> Research into replacing/augmenting the current Docker sandbox with a cloud-based runtime for running the `electric-agent` in production.

## Current Architecture

The existing `DockerSandboxProvider` (`src/web/sandbox/docker.ts`) manages containers locally via Docker Compose:

- **Base image**: `node:22-slim` with git, gh CLI, pnpm, Claude Code pre-installed
- **Communication**: NDJSON over stdin/stdout (bidirectional)
- **Port exposure**: Dynamic host port mapped to container port 5173 (Vite dev server)
- **File access**: `docker exec` for file listing, reading, and command execution
- **Lifecycle**: create → run agent → sleep/restart → destroy
- **Interface**: `SandboxProvider` in `src/web/sandbox/types.ts`

A cloud runtime must implement the same `SandboxProvider` interface: create, destroy, sendCommand (stdin), sendGateResponse (stdin), listFiles, readFile, exec, startApp, stopApp, isAppRunning, gitStatus, and createFromRepo.

---

## Option 1: Fly.io Sprites

**Website**: [sprites.dev](https://sprites.dev/)
**Launched**: January 2026 — still in RC (`v001-rc30`)

### What They Are

Sprites are persistent, stateful Linux VMs built on Firecracker microVMs. Unlike Fly Machines (which need Docker images pulled/unpacked in 30-60s), Sprites use a single pre-pooled base image on every worker node, achieving **1-2 second creation time**.

The architecture is "Docker without Docker without Docker" — no OCI images, no image registries. Storage uses a JuiceFS-like design: data chunks on S3-compatible object storage, metadata in local SQLite (durable via Litestream), and a 100GB NVMe volume as a read-through cache.

### Custom Base Image

**Not supported.** You cannot provide a Dockerfile or custom image. The base image includes internal orchestration infrastructure.

**Pre-installed in the standard image**: Node.js 22.20, Python 3.13, Go, Git, GitHub CLI (`gh`), Claude Code, Codex CLI, Gemini CLI.

**Workaround**: Install dependencies at runtime via a setup script. Since Sprites are persistent, you install once and packages survive sleep/wake cycles. Fly.io is exploring a "forking mechanism" (checkpoint a golden Sprite, fork new ones from it), but this is not yet available.

### HTTP Port Exposure

Each Sprite gets a unique URL on `*.sprites.app`. Traffic is routed to port **8080** inside the Sprite. You control access via:

```bash
sprite url -s <name> update --auth public
```

If the Sprite is sleeping, an incoming HTTP request **wakes it up automatically**, serves the response, then the Sprite sleeps again after 30s of inactivity.

**Limitations**:
- HTTP only — no raw TCP/UDP on public URLs
- No custom domains (must use `*.sprites.app`)
- Traffic routes to port 8080 only

### Programmatic API

**REST API** at `https://api.sprites.dev`:
- CRUD: `POST/GET/PUT/DELETE /v1/sprites/{name}`
- Exec: WebSocket at `/v1/sprites/{name}/exec` (stdin/stdout streaming)
- Services: background process management with auto-restart
- Checkpoints: create/restore (~300ms checkpoint, ~1s restore)
- Proxy: WebSocket TCP tunnel at `/v1/sprites/{name}/proxy`

**SDKs**:
- TypeScript: `@fly/sprites` (**requires Node.js 24+**)
- Go: `github.com/superfly/sprites-go`
- Python: `sprites-py`

```typescript
import { SpritesClient } from "@fly/sprites"

const client = new SpritesClient(process.env.SPRITES_TOKEN!)
const sprite = client.sprite("my-sprite")

// exec (mirrors child_process.exec)
const { stdout } = await sprite.exec("echo hello")

// spawn with streaming (mirrors child_process.spawn)
const cmd = sprite.spawn("node", ["server.js"])
cmd.stdout.on("data", (chunk) => process.stdout.write(chunk))
cmd.on("exit", (code) => console.log(`Exited: ${code}`))

// port detection events
cmd.on("message", (msg) => {
  if (msg.type === "port_opened") {
    console.log(`Port ${msg.port} opened by PID ${msg.pid}`)
  }
})
```

### Lifecycle

| State | Description | Billing |
|-------|-------------|---------|
| Running | Active, CPU/memory allocated | CPU + memory + hot storage |
| Warm | Idle, NVMe cache hot, instant resume | Storage only |
| Cold | Evicted from NVMe, data on object store | Cold storage only |
| Destroyed | Permanently deleted | Nothing |

**Auto-sleep**: 30 seconds of inactivity (not configurable). Background services alone do NOT prevent sleep. Only exec sessions and inbound HTTP requests keep it awake.

### Pricing

| Resource | Rate |
|----------|------|
| CPU | $0.07/CPU-hour |
| Memory | $0.04375/GB-hour |
| Hot Storage | $0.000683/GB-hour |
| Cold Storage | ~$0.02/GB-month |

Plans: $10/mo (10 warm), $20/mo (20 warm), $50/mo (50 warm). Free trial with $30 credit.

**Example**: 4-hour coding session ≈ $0.44. Idle sandbox ≈ $0.10/month for 10GB persisted.

### Fit Assessment

| Criterion | Score | Notes |
|-----------|-------|-------|
| Custom image | ❌ | No Dockerfile support. Must install deps at runtime. |
| Port exposure | ✅ | Built-in public URLs, HTTP only, port 8080. Need to adjust from 5173. |
| Programmatic API | ✅ | REST + TypeScript SDK with spawn/exec streaming. |
| Node.js + Git + gh | ✅ | All pre-installed. |
| stdin/stdout bridge | ⚠️ | SDK mirrors child_process — spawn gives stdout/stdin streams. Need to verify NDJSON compatibility. |
| Maturity | ⚠️ | Jan 2026 launch, API at RC stage. |
| Node.js 24 requirement | ⚠️ | SDK requires Node.js 24+. |
| Auto-sleep at 30s | ⚠️ | Could interrupt long agent operations with gaps between commands. |

---

## Option 2: E2B (Recommended)

**Website**: [e2b.dev](https://e2b.dev/)
**Maturity**: Production — used by 88% of Fortune 100, backed by $21M Series A

### What It Is

E2B provides cloud sandboxes purpose-built for AI agents. Each sandbox is a Firecracker microVM (same tech as AWS Lambda) with dedicated kernel and hardware-level isolation. Sandboxes start in **under 200ms**.

### Custom Base Image

**Supported via `e2b.Dockerfile`** (Debian-based images only):

```dockerfile
FROM ubuntu:22.04
RUN apt-get update && apt-get install -y nodejs npm git
RUN npm install -g pnpm
```

Build with: `e2b template init` then `e2b template build`. Also supports Build System 2.0 (code-first, no Dockerfile needed):

```typescript
const template = Template()
  .from_image("node:22-slim")
  .run_cmd("apt-get update && apt-get install -y git")
  .run_cmd("npm install -g pnpm")
```

### HTTP Port Exposure

Built-in public URLs per port:

```typescript
const sandbox = await Sandbox.create("my-template")
await sandbox.commands.run("pnpm dev", { background: true })
const host = sandbox.getHost(5173)
const url = `https://${host}` // https://5173-{id}.e2b.app
```

Access can be restricted with `allowPublicTraffic: false` + auth token header.

### Programmatic API

Mature TypeScript SDK (`e2b` on npm):

```typescript
import { Sandbox } from "e2b"

// Create
const sandbox = await Sandbox.create("my-template", { timeout: 3600 })

// Execute commands
const result = await sandbox.commands.run("npm run build")
console.log(result.stdout)

// File operations
await sandbox.files.write("/home/user/app.js", code)
const content = await sandbox.files.read("/home/user/app.js")
const files = await sandbox.files.list("/home/user")

// Port access
const host = sandbox.getHost(5173)

// Pause/resume for cost savings
const sandboxId = await sandbox.pause()
const resumed = await Sandbox.resume(sandboxId)

// Destroy
await sandbox.kill()
```

### Pricing

| Tier | Monthly | Sessions | Concurrency |
|------|---------|----------|-------------|
| Hobby | Free ($100 credit) | 1-hour max | 20 sandboxes |
| Pro | $150/mo | 24-hour max | Higher |
| Enterprise | Custom | Custom | Custom |

Usage: ~$0.05/hour per 1-vCPU sandbox, billed per second.

### Fit Assessment

| Criterion | Score | Notes |
|-----------|-------|-------|
| Custom image | ✅ | Dockerfile or code-first templates. Debian-based only. |
| Port exposure | ✅ | Built-in per-port public URLs. |
| Programmatic API | ✅ | Mature TypeScript SDK with files, commands, ports. |
| Node.js + Git + gh | ✅ | Install in custom template. |
| stdin/stdout bridge | ⚠️ | No native stdin pipe. Use `commands.run()` + file-based or WebSocket protocol instead. |
| Maturity | ✅ | Production-grade, Fortune 100 customers. |
| Session limits | ⚠️ | 1-hour (Hobby) or 24-hour (Pro) max. Extendable via pause/resume. |

---

## Option 3: Daytona

**Website**: [daytona.io](https://daytona.io/)
**Maturity**: Growing — $24M Series A (Feb 2026), pivoted to AI agent infrastructure

### What It Is

Daytona provides cloud sandboxes using Docker containers (Kata Containers optional) with sub-90ms cold starts (as low as 27ms claimed). Pivoted from dev environments to AI agent infrastructure in early 2025.

### Custom Base Image

**Any OCI/Docker image supported** — no distro restrictions. This is a significant advantage over E2B (Debian-only).

### HTTP Port Exposure

Built-in preview URLs:

```typescript
const sandbox = await daytona.create()
await sandbox.process.executeSessionCommand("pnpm dev &")
const previewUrl = sandbox.getPreviewLink(5173)
```

### Programmatic API

TypeScript SDK: `@daytonaio/sdk`

```typescript
import { Daytona } from "@daytonaio/sdk"

const daytona = new Daytona()
const sandbox = await daytona.create({ image: "node:22-slim" })

// Execute
const result = await sandbox.process.executeSessionCommand("npm install")

// File operations
await sandbox.fs.uploadFile("/home/user/file.js", content)
const data = await sandbox.fs.downloadFile("/home/user/file.js")

// Preview
const url = sandbox.getPreviewLink(5173)

// Lifecycle
await sandbox.pause()
await sandbox.resume()
await sandbox.delete()
```

### Pricing

~$0.067/hour for 1 vCPU / 1 GiB. $200 free credits (no credit card). Startup program with up to $50k credits.

### Fit Assessment

| Criterion | Score | Notes |
|-----------|-------|-------|
| Custom image | ✅ | Any OCI image, no restrictions. |
| Port exposure | ✅ | Built-in preview URLs. |
| Programmatic API | ✅ | TypeScript SDK available. |
| Node.js + Git + gh | ✅ | Install in custom image. |
| stdin/stdout bridge | ⚠️ | Command exec API, no native stdin pipe. |
| Maturity | ⚠️ | Newer, less battle-tested than E2B. |
| Session limits | ✅ | No session time limits. |
| Isolation | ⚠️ | Docker-based by default (shared kernel). Weaker than Firecracker. |

---

## Option 4: Cloudflare Sandbox SDK

**Website**: Cloudflare developer docs
**Maturity**: Public beta

Runs isolated containers on Cloudflare's edge network. Active-CPU billing means you only pay when the sandbox is consuming CPU cycles.

**Tradeoff**: Tightly coupled to Cloudflare Workers — your orchestration must run as a Worker. Pricing is attractive ($0.00002/vCPU-second active only) but the platform dependency is significant.

---

## Option 5: Modal

**Website**: [modal.com](https://modal.com/)

Powerful serverless compute with gVisor isolation and per-second billing. Public URL tunnels for exposed ports.

**Tradeoff**: The TypeScript SDK is in beta (v0.5) and lacks tunnel support. Sandbox networking features are **Python-only** today. This is a dealbreaker for a TypeScript orchestrator unless you wrap Modal's Python SDK.

---

## Options Not Recommended

| Platform | Why Not |
|----------|---------|
| **Railway / Render** | PaaS for persistent services, not ephemeral sandboxes. No checkpoint/fork/file APIs. Slow deploy cycles. |
| **Google Cloud Run** | Request-based serverless. 60-min timeout. No sandbox primitives. |
| **AWS Fargate** | Enterprise infra requiring VPC, ALB ($16+/mo), IAM, ECR. Orders of magnitude more complexity. |
| **GitHub Codespaces** | Designed for human devs, not AI agents. $0.18/hr minimum (3-4x E2B). No checkpoint/restore. |
| **Gitpod** | Sunset in October 2025. Transitioned to "Ona" with unclear API/pricing. |

---

## Comparison Matrix

| Feature | Docker (current) | Fly Sprites | E2B | Daytona |
|---------|-------------------|-------------|-----|---------|
| **Startup time** | 30-60s (build) | 1-2s | <200ms | <90ms |
| **Custom image** | ✅ Dockerfile | ❌ Standard only | ✅ Debian Dockerfile | ✅ Any OCI |
| **Port exposure** | Host port mapping | `*.sprites.app` | `*.e2b.app` | Preview URLs |
| **TypeScript SDK** | N/A (child_process) | `@fly/sprites` | `e2b` | `@daytonaio/sdk` |
| **File API** | `docker exec` | WebSocket exec | SDK files API | SDK fs API |
| **stdin/stdout** | ✅ Native | ✅ spawn streams | ❌ Command exec | ❌ Command exec |
| **Checkpoint/restore** | ❌ | ✅ 300ms/1s | ✅ Pause/resume | ✅ Pause/fork |
| **Isolation** | Container | Firecracker VM | Firecracker VM | Docker (Kata opt) |
| **Session limit** | None | None (auto-sleep 30s) | 24hr (Pro) | None |
| **Cost (idle)** | Host resources | ~$0 | ~$0 | ~$0 |
| **Cost (active/hr)** | Host resources | ~$0.11 | ~$0.05 | ~$0.067 |
| **Maturity** | Battle-tested | RC (Jan 2026) | Production | Growing |
| **Node.js 24 req** | No | SDK requires it | No | No |

---

## Key Architecture Decision: stdin/stdout vs Command Exec

The current architecture relies on NDJSON over stdin/stdout for communication between the web server and the container. This is the primary integration challenge for all cloud options.

### Current approach (Docker)
```
Web Server → docker compose run -i → container stdin (NDJSON)
Container → stdout → Web Server (NDJSON events)
```

### Adaptation strategies

**A. Sprites (best stdin/stdout compatibility)**:
The `@fly/sprites` SDK mirrors `child_process.spawn()`, providing readable/writable streams. The NDJSON protocol could work with minimal changes:
```typescript
const cmd = sprite.spawn("electric-agent", ["headless"])
cmd.stdin.write(JSON.stringify(config) + "\n")
cmd.stdout.on("data", parseNDJSON)
```
Concern: 30-second auto-sleep could kill the process mid-operation.

**B. E2B / Daytona (requires protocol adaptation)**:
No native stdin pipe. Options:
1. **Run headless agent as a background process** and communicate via files or a local HTTP server inside the sandbox
2. **WebSocket bridge**: Run a small WS server in the sandbox that bridges to the agent's stdin/stdout
3. **Refactor the NDJSON protocol** to use HTTP polling or WebSocket from the orchestrator to the sandbox

Option 2 (WebSocket bridge) is the cleanest: add a small bridge script that runs alongside the agent, accepting WebSocket connections and piping messages to/from the agent's stdin/stdout.

---

## Questions You Haven't Considered

### 1. PostgreSQL + Electric SQL Infrastructure
The current Docker setup optionally runs PostgreSQL and Electric SQL alongside the agent (local mode via docker-compose). In a cloud runtime:
- **Where does the database run?** You need a managed Postgres instance (e.g., Neon, Supabase, or Fly Postgres).
- **Where does Electric run?** You need a hosted Electric service or deploy it separately.
- Cloud mode already exists in your codebase (`InfraConfig.mode: "cloud"`), so this may already be solved — but it becomes mandatory rather than optional.

### 2. Cold Start vs. Pre-warming
If you use E2B/Daytona templates, building the template (installing deps) is a one-time cost. But if using Sprites without custom images, every new Sprite needs runtime setup. Consider:
- How long does `pnpm install` + scaffold take?
- Can you maintain a "golden checkpoint" or pre-warmed pool?

### 3. Session Persistence Across Provider Restarts
Your current sessions are persisted in `sessions.json`. The Docker containers are ephemeral but run locally. With cloud sandboxes:
- What happens if your web server restarts? Can it reconnect to running cloud sandboxes?
- How do you handle orphaned sandboxes (cloud VMs still running but no server managing them)?
- Do you need a cleanup/reaper process?

### 4. Cost Control and Abuse Prevention
With Docker, the cost is bounded by the host machine. With cloud sandboxes:
- What prevents a user from spinning up 100 sandboxes and leaving them running?
- Do you need per-user sandbox limits?
- Do you need a billing integration or usage tracking?
- How do you handle runaway processes inside sandboxes?

### 5. Network Latency
Docker exec is sub-millisecond (local IPC). Cloud sandbox commands go over the network:
- What's the round-trip latency for file reads/writes?
- Will the UI feel sluggish when browsing files in the sandbox?
- Should you batch file operations or cache aggressively?

### 6. Data Residency and Security
- Where are sandbox VMs located geographically?
- Is source code in the sandbox encrypted at rest?
- Can you comply with enterprise data residency requirements?
- The `ANTHROPIC_API_KEY` is injected as an env var — how is it protected in a cloud VM?

### 7. Multi-Provider Strategy
Should you support multiple cloud providers simultaneously?
- E2B for production (most mature)
- Docker for local development
- Sprites for users who prefer Fly.io
- The `SandboxProvider` interface makes this clean, but each provider will have subtle behavioral differences

### 8. The NDJSON Protocol Adaptation
This is the single biggest technical risk. The current architecture assumes synchronous stdin/stdout pipes. All cloud providers use async command execution APIs. You need to decide:
- Adapt the protocol (WebSocket bridge inside sandbox)?
- Refactor the orchestrator to not depend on stdin/stdout?
- Use a provider that supports streaming (Sprites)?

### 9. Preview URL Lifecycle
Currently, the preview port is a local port on the host machine. With cloud URLs:
- URLs are provider-specific (e.g., `*.e2b.app`, `*.sprites.app`)
- What happens when the sandbox sleeps? Does the URL return an error or a "waking up" page?
- Can you iframe these URLs in your web UI (CSP/CORS)?
- Do you need to proxy through your server for consistent URLs?

### 10. Concurrent Builds and Resource Contention
Docker runs on a single host with finite resources. Cloud providers have their own limits:
- E2B Pro: unspecified concurrent sandbox limit
- Sprites: 10-50 warm depending on plan
- What's your target concurrent user count?
- Do you need geographic distribution?

---

## Recommendation

### Primary: E2B

E2B is the strongest choice for production:
- Purpose-built for AI agent sandboxes
- Most mature TypeScript SDK
- Built-in preview URLs
- Firecracker isolation
- Custom Dockerfile templates
- Widest adoption and battle-testing

The main integration work is adapting the NDJSON stdin/stdout protocol to work with E2B's command execution API (likely via a WebSocket bridge script in the sandbox template).

### Secondary: Daytona

Daytona is a strong alternative with two advantages over E2B:
- Supports any OCI image (not just Debian)
- No session time limits

Choose Daytona if you need non-Debian base images or sessions longer than 24 hours.

### Honorable Mention: Fly.io Sprites

Sprites are the most technically interesting option and have the best stdin/stdout compatibility via the spawn API. However, the lack of custom base images, the Node.js 24 SDK requirement, the aggressive 30-second auto-sleep, and the immature API (still RC) make it riskier for production use today. Worth revisiting as the platform matures.

### Implementation Path

1. Create a new `E2BSandboxProvider` (or `DaytonaSandboxProvider`) implementing the existing `SandboxProvider` interface
2. Build a custom sandbox template with Node.js, pnpm, git, gh CLI, and a WebSocket bridge script
3. Adapt `container-bridge.ts` to use the SDK's command execution instead of Docker's stdin/stdout
4. Add provider selection to the infra config (local Docker vs. cloud E2B/Daytona)
5. Handle preview URL routing in the web UI (iframe the cloud provider's URL)
