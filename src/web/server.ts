import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { DurableStream } from "@durable-streams/client"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { inferProjectName } from "../agents/clarifier.js"
import type { EngineEvent } from "../engine/events.js"
import { ts } from "../engine/events.js"
import {
	type OrchestratorCallbacks,
	resolveProjectDir,
	runIterate,
	runNew,
} from "../engine/orchestrator.js"
import { createGate, rejectAllGates, resolveGate } from "./gate.js"
import { getStreamServerUrl } from "./infra.js"
import {
	addSession,
	getSession,
	readSessionIndex,
	type SessionInfo,
	updateSessionInfo,
} from "./sessions.js"

interface ServerConfig {
	port: number
	streamsPort: number
	dataDir: string
}

// Active orchestrator abort controllers
const activeRuns = new Map<string, AbortController>()

function streamUrl(streamsPort: number, sessionId: string): string {
	return `${getStreamServerUrl(streamsPort)}/session/${sessionId}`
}

/**
 * Create OrchestratorCallbacks that write events to a durable stream
 * and use gates for user interaction.
 */
function createWebCallbacks(
	sessionId: string,
	streamsPort: number,
): { callbacks: OrchestratorCallbacks; streamHandle: DurableStream } {
	const url = streamUrl(streamsPort, sessionId)
	const streamHandle = new DurableStream({
		url,
		contentType: "application/json",
	})

	const callbacks: OrchestratorCallbacks = {
		async onEvent(event: EngineEvent) {
			try {
				await streamHandle.append(JSON.stringify(event))
			} catch {
				// Stream may be closed or unavailable, swallow errors
			}
		},

		async onClarificationNeeded(_questions, _summary) {
			// The orchestrator already emits the clarification_needed event via onEvent.
			// We only need to block until the user answers via POST /api/sessions/:id/respond.
			return createGate<string[]>(sessionId, "clarification")
		},

		async onPlanReady(_plan) {
			// The orchestrator already emits the plan_ready event via onEvent.
			return createGate<"approve" | "revise" | "cancel">(sessionId, "approval")
		},

		async onRevisionRequested() {
			return createGate<string>(sessionId, "revision")
		},

		async onContinueNeeded() {
			// The orchestrator already emits the continue_needed event via onEvent.
			return createGate<boolean>(sessionId, "continue")
		},
	}

	return { callbacks, streamHandle }
}

export function createApp(config: ServerConfig) {
	const app = new Hono()

	// CORS for local development
	app.use("*", cors({ origin: "*" }))

	// --- API Routes ---

	// List all sessions
	app.get("/api/sessions", (c) => {
		const index = readSessionIndex(config.dataDir)
		return c.json(index)
	})

	// Get single session
	app.get("/api/sessions/:id", (c) => {
		const session = getSession(config.dataDir, c.req.param("id"))
		if (!session) return c.json({ error: "Session not found" }, 404)
		return c.json(session)
	})

	// Start new project
	app.post("/api/sessions", async (c) => {
		const body = (await c.req.json()) as {
			description: string
			name?: string
			baseDir?: string
		}

		if (!body.description) {
			return c.json({ error: "description is required" }, 400)
		}

		const sessionId = crypto.randomUUID()
		const inferredName = body.name || (await inferProjectName(body.description))
		const baseDir = body.baseDir || process.cwd()
		const { projectName, projectDir } = resolveProjectDir(baseDir, inferredName)

		// Create the durable stream
		const url = streamUrl(config.streamsPort, sessionId)
		try {
			await DurableStream.create({
				url,
				contentType: "application/json",
			})
		} catch {
			return c.json({ error: "Failed to create event stream" }, 500)
		}

		// Record session
		const session: SessionInfo = {
			id: sessionId,
			projectName,
			projectDir,
			description: body.description,
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: "running",
		}
		addSession(config.dataDir, session)

		// Start orchestrator in the background
		const controller = new AbortController()
		activeRuns.set(sessionId, controller)

		const { callbacks } = createWebCallbacks(sessionId, config.streamsPort)

		// Write user prompt to the stream so it shows in the UI
		await callbacks.onEvent({
			type: "user_message",
			message: body.description,
			ts: ts(),
		})

		// Fire and forget — the orchestrator writes results to the stream
		runNew({
			description: body.description,
			projectName,
			baseDir,
			callbacks,
		})
			.then(() => {
				updateSessionInfo(config.dataDir, sessionId, { status: "complete" })
			})
			.catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : "Unknown error"
				callbacks.onEvent({
					type: "log",
					level: "error",
					message: msg,
					ts: ts(),
				})
				updateSessionInfo(config.dataDir, sessionId, { status: "error" })
			})
			.finally(() => {
				activeRuns.delete(sessionId)
			})

		return c.json({ sessionId, streamUrl: url }, 201)
	})

	// Send iteration request
	app.post("/api/sessions/:id/iterate", async (c) => {
		const sessionId = c.req.param("id")
		const session = getSession(config.dataDir, sessionId)
		if (!session) return c.json({ error: "Session not found" }, 404)

		const body = (await c.req.json()) as { request: string }
		if (!body.request) {
			return c.json({ error: "request is required" }, 400)
		}

		// Re-use the existing stream (append to same log)
		const { callbacks } = createWebCallbacks(sessionId, config.streamsPort)

		// Write user prompt to the stream so it shows in the UI
		await callbacks.onEvent({
			type: "user_message",
			message: body.request,
			ts: ts(),
		})

		updateSessionInfo(config.dataDir, sessionId, { status: "running" })
		const controller = new AbortController()
		activeRuns.set(sessionId, controller)

		runIterate({
			projectDir: session.projectDir,
			userRequest: body.request,
			callbacks,
		})
			.then(() => {
				updateSessionInfo(config.dataDir, sessionId, { status: "complete" })
			})
			.catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : "Unknown error"
				callbacks.onEvent({
					type: "log",
					level: "error",
					message: msg,
					ts: ts(),
				})
				updateSessionInfo(config.dataDir, sessionId, { status: "error" })
			})
			.finally(() => {
				activeRuns.delete(sessionId)
			})

		return c.json({ ok: true })
	})

	// Respond to a gate (approval, clarification, continue, revision)
	app.post("/api/sessions/:id/respond", async (c) => {
		const sessionId = c.req.param("id")
		const body = (await c.req.json()) as Record<string, unknown>
		const gate = body.gate as string

		if (!gate) {
			return c.json({ error: "gate is required" }, 400)
		}

		let value: unknown
		switch (gate) {
			case "clarification":
				value = body.answers as string[]
				break
			case "approval":
				value = body.decision as string
				break
			case "revision":
				value = body.feedback as string
				break
			case "continue":
				value = body.proceed as boolean
				break
			default:
				return c.json({ error: `Unknown gate: ${gate}` }, 400)
		}

		const resolved = resolveGate(sessionId, gate, value)
		if (!resolved) {
			return c.json({ error: "No pending gate found" }, 404)
		}

		return c.json({ ok: true })
	})

	// Cancel a running session
	app.post("/api/sessions/:id/cancel", (c) => {
		const sessionId = c.req.param("id")
		const controller = activeRuns.get(sessionId)
		if (controller) {
			controller.abort()
			activeRuns.delete(sessionId)
		}
		rejectAllGates(sessionId)
		updateSessionInfo(config.dataDir, sessionId, { status: "cancelled" })
		return c.json({ ok: true })
	})

	// Serve static SPA files (if built)
	const clientDir = path.resolve(
		path.dirname(new URL(import.meta.url).pathname),
		"../../dist/web/client",
	)
	if (fs.existsSync(clientDir)) {
		app.use("/*", serveStatic({ root: clientDir }))
		// SPA fallback: serve index.html for non-API routes
		app.get("*", (c) => {
			const indexPath = path.join(clientDir, "index.html")
			if (fs.existsSync(indexPath)) {
				return c.html(fs.readFileSync(indexPath, "utf-8"))
			}
			return c.text("Web UI not built. Run: npm run build:web", 404)
		})
	} else {
		app.get("/", (c) => {
			return c.text("Web UI not built. Run: npm run build:web", 404)
		})
	}

	return app
}

export async function startWebServer(opts: {
	port?: number
	streamsPort?: number
	dataDir?: string
}): Promise<void> {
	const config: ServerConfig = {
		port: opts.port ?? 4400,
		streamsPort: opts.streamsPort ?? 4437,
		dataDir: opts.dataDir ?? path.resolve(process.cwd(), ".electric-agent"),
	}

	fs.mkdirSync(config.dataDir, { recursive: true })

	const app = createApp(config)

	serve({
		fetch: app.fetch,
		port: config.port,
		hostname: "127.0.0.1",
	})

	console.log(`Web UI server running at http://127.0.0.1:${config.port}`)
	console.log(`Stream URL base: ${getStreamServerUrl(config.streamsPort)}`)
}
