/**
 * Cloudflare Pages _worker.js — full API server (Advanced Mode).
 *
 * Runs the entire API on the edge: KV-backed sessions, stateless DS bridge,
 * SSE proxy, Electric provisioning, and GitHub API. Static SPA assets are
 * served via the ASSETS binding.
 *
 * Sandbox management (Daytona) is stubbed — see TODO comments.
 */

import { DurableStream } from "@durable-streams/client"
import { Hono } from "hono"
import { cors } from "hono/cors"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
	SESSIONS: KVNamespace
	ASSETS: { fetch: typeof fetch }
	// Durable Streams (server-infra secrets — safe to deploy)
	DS_URL: string
	DS_SERVICE_ID: string
	DS_SECRET: string
	// Sandbox infra (server-infra secrets — safe to deploy)
	DAYTONA_API_KEY: string
	DAYTONA_API_URL: string
	DAYTONA_TARGET: string
	SANDBOX_SNAPSHOT: string
	// Legacy proxy fallback
	API_BACKEND_URL: string
	// NOTE: ANTHROPIC_API_KEY and GH_TOKEN are NOT here.
	// Users provide their own credentials — those flow directly
	// into the sandbox as env vars, never through the Worker.
}

interface SessionInfo {
	id: string
	projectName: string
	sandboxProjectDir: string
	description: string
	createdAt: string
	lastActiveAt: string
	status: "running" | "complete" | "error" | "cancelled"
	lastCoderSessionId?: string
	appPort?: number
	previewUrl?: string
	claimId?: string
	git?: {
		branch: string
		remoteUrl: string | null
		repoName: string | null
		repoVisibility?: "public" | "private"
		lastCommitHash: string | null
		lastCommitMessage: string | null
		lastCheckpointAt: string | null
	}
	/** Worker state machine — tracks where in the creation flow we are */
	_workerState?: "awaiting_config" | "creating_sandbox" | "running" | "complete" | "error"
	/** Daytona sandbox ID (if created) */
	_sandboxId?: string
}

interface StreamConnectionInfo {
	url: string
	headers: Record<string, string>
}

type LogLevel = "plan" | "approve" | "task" | "build" | "fix" | "done" | "error" | "verbose"

// ---------------------------------------------------------------------------
// Helpers — timestamps
// ---------------------------------------------------------------------------

function ts(): string {
	return new Date().toISOString()
}

// ---------------------------------------------------------------------------
// Helpers — stream connection
// ---------------------------------------------------------------------------

function streamConn(env: Env, sessionId: string): StreamConnectionInfo {
	return {
		url: `${env.DS_URL}/v1/stream/${env.DS_SERVICE_ID}/session/${sessionId}`,
		headers: { Authorization: `Bearer ${env.DS_SECRET}` },
	}
}

// ---------------------------------------------------------------------------
// Helpers — DS read/write (stateless per-request)
// ---------------------------------------------------------------------------

async function dsCreate(conn: StreamConnectionInfo): Promise<void> {
	await DurableStream.create({
		url: conn.url,
		headers: conn.headers,
		contentType: "application/json",
	})
}

async function dsAppend(conn: StreamConnectionInfo, data: Record<string, unknown>): Promise<void> {
	const ds = new DurableStream({
		url: conn.url,
		headers: conn.headers,
		contentType: "application/json",
	})
	await ds.append(JSON.stringify({ source: "server", ...data }))
}

async function dsAppendCommand(
	conn: StreamConnectionInfo,
	cmd: Record<string, unknown>,
): Promise<void> {
	await dsAppend(conn, { type: "command", ts: ts(), ...cmd })
}

async function dsAppendGateResponse(
	conn: StreamConnectionInfo,
	gate: string,
	value: Record<string, unknown>,
): Promise<void> {
	await dsAppend(conn, { type: "gate_response", gate, ts: ts(), ...value })
}

// ---------------------------------------------------------------------------
// Helpers — KV session storage
// ---------------------------------------------------------------------------

function sessionKey(id: string): string {
	return `session:${id}`
}

async function kvGetSession(kv: KVNamespace, id: string): Promise<SessionInfo | null> {
	const raw = await kv.get(sessionKey(id))
	return raw ? (JSON.parse(raw) as SessionInfo) : null
}

async function kvPutSession(kv: KVNamespace, session: SessionInfo): Promise<void> {
	session.lastActiveAt = new Date().toISOString()
	await kv.put(sessionKey(session.id), JSON.stringify(session))
}

async function kvUpdateSession(
	kv: KVNamespace,
	id: string,
	update: Partial<SessionInfo>,
): Promise<SessionInfo | null> {
	const session = await kvGetSession(kv, id)
	if (!session) return null
	Object.assign(session, update)
	await kvPutSession(kv, session)
	return session
}

async function kvDeleteSession(kv: KVNamespace, id: string): Promise<boolean> {
	const exists = await kv.get(sessionKey(id))
	if (!exists) return false
	await kv.delete(sessionKey(id))
	return true
}

async function kvListSessions(kv: KVNamespace): Promise<SessionInfo[]> {
	const list = await kv.list({ prefix: "session:" })
	const sessions: SessionInfo[] = []
	for (const key of list.keys) {
		const raw = await kv.get(key.name)
		if (raw) {
			sessions.push(JSON.parse(raw) as SessionInfo)
		}
	}
	// Sort by creation date descending
	sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
	return sessions
}

// ---------------------------------------------------------------------------
// Helpers — simple project name derivation (no LLM call)
// ---------------------------------------------------------------------------

function deriveProjectName(description: string): string {
	const words = description
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, "")
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 3)
	const name = words.join("-") || "electric-app"
	return name.slice(0, 40)
}

// ---------------------------------------------------------------------------
// Helpers — Electric provisioning (pure fetch, Worker-safe)
// ---------------------------------------------------------------------------

const ELECTRIC_API_BASE = "https://dashboard.electric-sql.cloud/api"
const ELECTRIC_URL = "https://api.electric-sql.cloud"
const ELECTRIC_DASHBOARD_URL = "https://dashboard.electric-sql.cloud"

function getClaimUrl(claimId: string): string {
	return `${ELECTRIC_DASHBOARD_URL}/claim?uuid=${claimId}`
}

async function provisionElectricResources(): Promise<{
	source_id: string
	secret: string
	DATABASE_URL: string
	claimId: string
}> {
	const resp = await fetch(`${ELECTRIC_API_BASE}/public/v1/claimable-sources`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": "create-electric-app",
		},
		body: JSON.stringify({}),
	})

	if (!resp.ok) {
		throw new Error(`Electric API error: ${resp.status} ${resp.statusText}`)
	}

	const { claimId } = (await resp.json()) as { claimId: string }
	if (!claimId) throw new Error("Invalid response — missing claimId")

	// Poll for ready state
	for (let i = 0; i < 60; i++) {
		const poll = await fetch(`${ELECTRIC_API_BASE}/public/v1/claimable-sources/${claimId}`, {
			headers: { "User-Agent": "create-electric-app" },
		})
		if (poll.status === 404) {
			await new Promise((r) => setTimeout(r, 1000))
			continue
		}
		if (!poll.ok) {
			throw new Error(`Electric API error: ${poll.status}`)
		}
		const status = (await poll.json()) as {
			state: string
			source: { source_id: string; secret: string }
			connection_uri: string
			error: string | null
		}
		if (status.state === "ready") {
			return {
				source_id: status.source.source_id,
				secret: status.source.secret,
				DATABASE_URL: status.connection_uri,
				claimId,
			}
		}
		if (status.state === "failed" || status.error) {
			throw new Error(`Provisioning failed: ${status.error}`)
		}
		await new Promise((r) => setTimeout(r, 1000))
	}
	throw new Error("Timeout waiting for Electric resources")
}

// ---------------------------------------------------------------------------
// Helpers — git op detection
// ---------------------------------------------------------------------------

function detectGitOp(request: string): {
	gitOp: string
	gitMessage?: string
	gitPrTitle?: string
} | null {
	const lower = request.toLowerCase().trim()

	if (/^(git\s+)?commit\b/.test(lower) || /^save\s+(my\s+)?(changes|progress|work)\b/.test(lower)) {
		const msgMatch = request.match(
			/(?:commit\s+(?:with\s+(?:message\s+)?)?|message:\s*|msg:\s*)["']?(.+?)["']?\s*$/i,
		)
		const message = msgMatch?.[1]?.replace(/^(the\s+)?(code|changes)\s*/i, "").trim()
		return { gitOp: "commit", gitMessage: message || undefined }
	}

	if (/^(git\s+)?push\b/.test(lower)) {
		return { gitOp: "push" }
	}

	if (/^(create|open|make)\s+(a\s+)?(pr|pull\s*request)\b/.test(lower)) {
		const titleMatch = request.match(
			/(?:pr|pull\s*request)\s+(?:(?:titled?|called|named)\s+)?["']?(.+?)["']?\s*$/i,
		)
		return { gitOp: "create-pr", gitPrTitle: titleMatch?.[1] || undefined }
	}

	return null
}

// ---------------------------------------------------------------------------
// Sandbox stubs (TODO: wire Daytona SDK)
// ---------------------------------------------------------------------------

// TODO: Implement Daytona sandbox operations for Workers
// The @daytonaio/sdk is pure-fetch and should work in Workers.
// Key operations needed:
//   - createSandbox(env, sessionId, opts) → { sandboxId, previewUrl, projectDir }
//   - destroySandbox(env, sandboxId)
//   - execInSandbox(env, sandboxId, cmd) → string
//   - getSandboxPreviewUrl(env, sandboxId, port) → string
//   - listFilesInSandbox(env, sandboxId, dir) → string[]
//   - readFileInSandbox(env, sandboxId, path) → string | null
//   - gitStatusInSandbox(env, sandboxId, dir) → GitStatus
//   - isAppRunning(env, sandboxId) → boolean
//   - startApp(env, sandboxId) → boolean
//   - stopApp(env, sandboxId) → void

function sandboxNotImplemented(): Response {
	return new Response(JSON.stringify({ error: "Sandbox not yet implemented in Worker" }), {
		status: 501,
		headers: { "content-type": "application/json" },
	})
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>()

app.use("*", cors({ origin: "*" }))

// --- Health check ---

app.get("/api/health", async (c) => {
	const checks: Record<string, "ok" | "error"> = {}
	let healthy = true

	// KV binding
	try {
		await c.env.SESSIONS.get("__health_check__")
		checks.kv = "ok"
	} catch {
		checks.kv = "error"
		healthy = false
	}

	// Durable Streams config
	if (c.env.DS_URL && c.env.DS_SERVICE_ID && c.env.DS_SECRET) {
		checks.ds_config = "ok"
	} else {
		checks.ds_config = "error"
		healthy = false
	}

	// Daytona config (optional — warn but don't fail health)
	checks.daytona_config = c.env.DAYTONA_API_KEY ? "ok" : "error"

	return c.json({ healthy, checks }, healthy ? 200 : 503)
})

// --- Electric provisioning ---

app.post("/api/provision-electric", async (c) => {
	try {
		const result = await provisionElectricResources()
		return c.json({
			sourceId: result.source_id,
			secret: result.secret,
			databaseUrl: result.DATABASE_URL,
			electricUrl: ELECTRIC_URL,
			claimId: result.claimId,
			claimUrl: getClaimUrl(result.claimId),
		})
	} catch (err) {
		const message = err instanceof Error ? err.message : "Provisioning failed"
		return c.json({ error: message }, 500)
	}
})

// --- Session CRUD ---

app.get("/api/sessions", async (c) => {
	const sessions = await kvListSessions(c.env.SESSIONS)
	return c.json({ sessions })
})

app.get("/api/sessions/:id", async (c) => {
	const session = await kvGetSession(c.env.SESSIONS, c.req.param("id"))
	if (!session) return c.json({ error: "Session not found" }, 404)
	return c.json(session)
})

app.post("/api/sessions", async (c) => {
	const body = (await c.req.json()) as {
		description: string
		name?: string
		apiKey?: string
		ghToken?: string
	}
	if (!body.description) {
		return c.json({ error: "description is required" }, 400)
	}

	const sessionId = crypto.randomUUID()
	const projectName = body.name || deriveProjectName(body.description)
	const conn = streamConn(c.env, sessionId)

	// Create the durable stream
	try {
		await dsCreate(conn)
	} catch (err) {
		console.error("[session] Failed to create durable stream:", err)
		return c.json({ error: "Failed to create event stream" }, 500)
	}

	// Record session in KV
	const sandboxProjectDir = `/home/agent/workspace/${projectName}`
	const session: SessionInfo = {
		id: sessionId,
		projectName,
		sandboxProjectDir,
		description: body.description,
		createdAt: new Date().toISOString(),
		lastActiveAt: new Date().toISOString(),
		status: "running",
		_workerState: "awaiting_config",
	}
	await kvPutSession(c.env.SESSIONS, session)

	// Write user prompt to the stream
	await dsAppend(conn, {
		type: "user_message",
		message: body.description,
		ts: ts(),
	})

	// Emit the infra config gate (no GH accounts — credentials are user-provided in sandbox)
	await dsAppend(conn, {
		type: "infra_config_prompt",
		projectName,
		ghAccounts: [],
		ts: ts(),
	})

	return c.json({ sessionId }, 201)
})

// --- Iterate ---

app.post("/api/sessions/:id/iterate", async (c) => {
	const sessionId = c.req.param("id")
	const session = await kvGetSession(c.env.SESSIONS, sessionId)
	if (!session) return c.json({ error: "Session not found" }, 404)

	const body = (await c.req.json()) as { request: string }
	if (!body.request) {
		return c.json({ error: "request is required" }, 400)
	}

	const conn = streamConn(c.env, sessionId)

	// Intercept git commands
	const gitOp = detectGitOp(body.request)
	if (gitOp) {
		await dsAppend(conn, {
			type: "user_message",
			message: body.request,
			ts: ts(),
		})
		await dsAppendCommand(conn, {
			command: "git",
			projectDir: session.sandboxProjectDir,
			...gitOp,
		})
		return c.json({ ok: true })
	}

	// Write user prompt to stream
	await dsAppend(conn, {
		type: "user_message",
		message: body.request,
		ts: ts(),
	})

	await kvUpdateSession(c.env.SESSIONS, sessionId, { status: "running" })

	// Send iterate command to sandbox via DS
	await dsAppendCommand(conn, {
		command: "iterate",
		projectDir: session.sandboxProjectDir,
		request: body.request,
		resumeSessionId: session.lastCoderSessionId,
	})

	return c.json({ ok: true })
})

// --- Gate responses ---

app.post("/api/sessions/:id/respond", async (c) => {
	const sessionId = c.req.param("id")
	const body = (await c.req.json()) as Record<string, unknown>
	const gate = body.gate as string
	if (!gate) return c.json({ error: "gate is required" }, 400)

	const summary = (body._summary as string) || undefined
	const conn = streamConn(c.env, sessionId)

	// Server-side gates are handled inline
	if (gate === "infra_config") {
		const session = await kvGetSession(c.env.SESSIONS, sessionId)
		if (!session) return c.json({ error: "Session not found" }, 404)

		// Build infra config
		let repoConfig: {
			account: string
			repoName: string
			visibility: "public" | "private"
		} | null = null

		if ((body.repoAccount as string) && (body.repoName as string)?.toString().trim()) {
			repoConfig = {
				account: body.repoAccount as string,
				repoName: body.repoName as string,
				visibility: (body.repoVisibility as "public" | "private") ?? "private",
			}
		}

		// Update session with infra + repo config
		const updates: Partial<SessionInfo> = {
			_workerState: "creating_sandbox",
		}
		if (body.claimId) {
			updates.claimId = body.claimId as string
		}
		if (repoConfig) {
			updates.git = {
				branch: "main",
				remoteUrl: null,
				repoName: `${repoConfig.account}/${repoConfig.repoName}`,
				repoVisibility: repoConfig.visibility,
				lastCommitHash: null,
				lastCommitMessage: null,
				lastCheckpointAt: null,
			}
		}
		await kvUpdateSession(c.env.SESSIONS, sessionId, updates)

		// Persist gate resolution for replay
		await dsAppend(conn, { type: "gate_resolved", gate, summary, ts: ts() })

		// TODO: Create sandbox via Daytona, then send "new" command to DS.
		// For now, emit a log event explaining the limitation.
		// When Daytona is wired:
		//   1. const handle = await createSandbox(c.env, sessionId, { projectName, infra, apiKey: session._apiKey, ghToken: session._ghToken })
		//   2. await kvUpdateSession(kv, sessionId, { _workerState: "running", _sandboxId: handle.sandboxId, ... })
		//   3. await dsAppendCommand(conn, { command: "new", description, projectName, ... })
		await dsAppend(conn, {
			type: "log",
			level: "error" as LogLevel,
			message:
				"Sandbox creation not yet implemented in Worker mode. Deploy with Fly.io backend for full functionality.",
			ts: ts(),
		})

		return c.json({ ok: true })
	}

	// Agent gates — forward to DS for the sandbox to pick up
	const { gate: _, _summary: _s, ...value } = body
	await dsAppendGateResponse(conn, gate, value as Record<string, unknown>)

	// Persist gate resolution for replay
	try {
		await dsAppend(conn, { type: "gate_resolved", gate, summary, ts: ts() })
	} catch {
		// Non-critical
	}

	return c.json({ ok: true })
})

// --- App lifecycle (sandbox-dependent) ---

app.get("/api/sessions/:id/app-status", async (c) => {
	const session = await kvGetSession(c.env.SESSIONS, c.req.param("id"))
	if (!session) return c.json({ error: "Session not found" }, 404)
	if (!session._sandboxId) {
		return c.json({ running: false, port: session.appPort })
	}
	// TODO: check via Daytona SDK
	return c.json({ running: false, port: session.appPort })
})

app.post("/api/sessions/:id/start-app", () => sandboxNotImplemented())
app.post("/api/sessions/:id/stop-app", () => sandboxNotImplemented())

// --- Cancel / Delete ---

app.post("/api/sessions/:id/cancel", async (c) => {
	const sessionId = c.req.param("id")
	const session = await kvGetSession(c.env.SESSIONS, sessionId)
	if (!session) return c.json({ error: "Session not found" }, 404)

	// TODO: destroy sandbox via Daytona SDK if session._sandboxId

	await kvUpdateSession(c.env.SESSIONS, sessionId, {
		status: "cancelled",
		_workerState: "error",
	})
	return c.json({ ok: true })
})

app.delete("/api/sessions/:id", async (c) => {
	const sessionId = c.req.param("id")
	const _session = await kvGetSession(c.env.SESSIONS, sessionId)

	// TODO: destroy sandbox via Daytona SDK if session?._sandboxId

	const deleted = await kvDeleteSession(c.env.SESSIONS, sessionId)
	if (!deleted) return c.json({ error: "Session not found" }, 404)
	return c.json({ ok: true })
})

// --- Sandbox CRUD ---

app.get("/api/sandboxes", () => {
	// TODO: list via Daytona SDK
	return new Response(JSON.stringify({ sandboxes: [] }), {
		headers: { "content-type": "application/json" },
	})
})

app.get("/api/sandboxes/:sessionId", () => sandboxNotImplemented())
app.post("/api/sandboxes", () => sandboxNotImplemented())
app.delete("/api/sandboxes/:sessionId", () => sandboxNotImplemented())

// --- SSE Proxy ---

app.get("/api/sessions/:id/events", async (c) => {
	const sessionId = c.req.param("id")
	const session = await kvGetSession(c.env.SESSIONS, sessionId)
	if (!session) return c.json({ error: "Session not found" }, 404)

	const conn = streamConn(c.env, sessionId)
	const lastEventId = c.req.header("Last-Event-ID") || "-1"

	const reader = new DurableStream({
		url: conn.url,
		headers: conn.headers,
		contentType: "application/json",
	})

	const { readable, writable } = new TransformStream()
	const writer = writable.getWriter()
	const encoder = new TextEncoder()

	let cancelled = false

	const response = await reader.stream<Record<string, unknown>>({
		offset: lastEventId,
		live: true,
	})

	const cancel = response.subscribeJson<Record<string, unknown>>((batch) => {
		if (cancelled) return
		for (const item of batch.items) {
			const msgType = item.type as string | undefined
			// Filter protocol messages
			if (msgType === "command" || msgType === "gate_response") continue

			const { source: _, ...eventData } = item
			const data = JSON.stringify(eventData)
			writer.write(encoder.encode(`id:${batch.offset}\ndata:${data}\n\n`)).catch(() => {
				cancelled = true
			})
		}
	})

	// Clean up when client disconnects
	c.req.raw.signal.addEventListener("abort", () => {
		cancelled = true
		cancel()
		writer.close().catch(() => {})
	})

	return new Response(readable, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"Access-Control-Allow-Origin": "*",
		},
	})
})

// --- Git/GitHub (file/sandbox routes are sandbox-dependent) ---

app.get("/api/sessions/:id/git-status", () => sandboxNotImplemented())

app.get("/api/sessions/:id/files", async (c) => {
	const session = await kvGetSession(c.env.SESSIONS, c.req.param("id"))
	if (!session) return c.json({ error: "Session not found" }, 404)
	// TODO: list files via Daytona SDK
	return c.json({ files: [], prefix: session.sandboxProjectDir })
})

app.get("/api/sessions/:id/file-content", () => sandboxNotImplemented())

// GitHub routes return empty — credentials are user-provided and flow into the sandbox.
// The sandbox handles all GitHub operations (commit, push, PR) directly.
app.get("/api/github/accounts", (c) => c.json({ accounts: [] }))
app.get("/api/github/repos", (c) => c.json({ repos: [] }))
app.get("/api/github/repos/:owner/:repo/branches", (c) => c.json({ branches: [] }))

// --- Resume from repo (sandbox-dependent) ---

app.post("/api/sessions/resume", () => sandboxNotImplemented())

// --- Static assets ---

app.get("*", async (c) => {
	const response = await c.env.ASSETS.fetch(c.req.raw)
	if (response.status !== 404) return response
	// SPA fallback
	const url = new URL(c.req.url)
	const indexUrl = new URL("/index.html", url.origin)
	return c.env.ASSETS.fetch(new Request(indexUrl, c.req.raw))
})

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default {
	fetch: app.fetch,
}
