import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { DurableStream } from "@durable-streams/client"
import type { EngineEvent, Participant, SharedSessionEvent } from "@electric-agent/protocol"
import { ts } from "@electric-agent/protocol"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { ActiveSessions } from "./active-sessions.js"
import { ClaudeCodeDockerBridge, type ClaudeCodeDockerConfig } from "./bridge/claude-code-docker.js"
import {
	ClaudeCodeSpritesBridge,
	type ClaudeCodeSpritesConfig,
} from "./bridge/claude-code-sprites.js"
import {
	createAppSkillContent,
	generateClaudeMd,
	resolveRoleSkill,
	roomMessagingSkillContent,
} from "./bridge/claude-md-generator.js"
import { HostedStreamBridge } from "./bridge/hosted.js"
import type { SessionBridge } from "./bridge/types.js"
import { DEFAULT_ELECTRIC_URL, getClaimUrl, provisionElectricResources } from "./electric-api.js"
import { createGate, rejectAllGates, resolveGate } from "./gate.js"
import { ghListAccounts, ghListBranches, ghListRepos, isGhAuthenticated } from "./git.js"
import { resolveProjectDir } from "./project-utils.js"
import type { RoomRegistry } from "./room-registry.js"
import { type RoomParticipant, RoomRouter } from "./room-router.js"
import type { DockerSandboxProvider as DockerSandboxProviderType } from "./sandbox/docker.js"
import type { InfraConfig, SandboxProvider } from "./sandbox/index.js"
import type { SpritesSandboxProvider as SpritesSandboxProviderType } from "./sandbox/sprites.js"
import {
	deriveHookToken,
	deriveSessionToken,
	validateHookToken,
	validateSessionToken,
} from "./session-auth.js"
import type { SessionInfo } from "./sessions.js"
import { generateInviteCode } from "./shared-sessions.js"
import {
	getRoomStreamConnectionInfo,
	getSharedStreamConnectionInfo,
	getStreamConnectionInfo,
	type StreamConfig,
	type StreamConnectionInfo,
} from "./streams.js"

type BridgeMode = "claude-code"

interface ServerConfig {
	port: number
	dataDir: string
	/** In-memory session tracking (current server lifetime only) */
	sessions: ActiveSessions
	/** DS-backed room registry (persists across restarts) */
	rooms: RoomRegistry
	sandbox: SandboxProvider
	/** Hosted stream config — required */
	streamConfig: StreamConfig
	/** Bridge mode — always "claude-code" */
	bridgeMode: BridgeMode
}

/** Active session bridges — one per running session */
const bridges = new Map<string, SessionBridge>()

/** In-memory room presence: roomId → participantId → { displayName, lastPing } */
const roomPresence = new Map<string, Map<string, { displayName: string; lastPing: number }>>()

/** Active room routers — one per room with agent-to-agent messaging */
const roomRouters = new Map<string, RoomRouter>()

/** Inflight hook session creations — prevents duplicate sessions from concurrent hooks */
const inflightHookCreations = new Map<string, Promise<string>>()

function parseRepoNameFromUrl(url: string | null): string | null {
	if (!url) return null
	const match = url.match(/github\.com[/:](.+?)(?:\.git)?$/)
	return match?.[1] ?? null
}

/** Get stream connection info for a session (URL + auth headers) */
function sessionStream(config: ServerConfig, sessionId: string): StreamConnectionInfo {
	return getStreamConnectionInfo(sessionId, config.streamConfig)
}

/** Get stream connection info for a shared session */
function sharedSessionStream(config: ServerConfig, sharedSessionId: string): StreamConnectionInfo {
	return getSharedStreamConnectionInfo(sharedSessionId, config.streamConfig)
}

/** Get stream connection info for a room */
function roomStream(config: ServerConfig, roomId: string): StreamConnectionInfo {
	return getRoomStreamConnectionInfo(roomId, config.streamConfig)
}

/** Create or retrieve the SessionBridge for a session */
function getOrCreateBridge(config: ServerConfig, sessionId: string): SessionBridge {
	let bridge = bridges.get(sessionId)
	if (!bridge) {
		const conn = sessionStream(config, sessionId)
		bridge = new HostedStreamBridge(sessionId, conn)
		bridges.set(sessionId, bridge)
	}
	return bridge
}

/**
 * Resolve the studio server URL for remote sandboxes (Sprites).
 * On Fly.io: uses the app's public HTTPS URL.
 * Locally: falls back to ngrok/tailscale URL from STUDIO_URL env, or localhost (won't work from sprites).
 */
function resolveStudioUrl(port: number): string {
	// Explicit override (e.g. ngrok tunnel for local dev with sprites)
	if (process.env.STUDIO_URL) return process.env.STUDIO_URL
	// Fly.io — FLY_APP_NAME is set automatically
	const flyApp = process.env.FLY_APP_NAME
	if (flyApp) return `https://${flyApp}.fly.dev`
	// Fallback — won't work from sprites VMs, but at least logs a useful URL
	return `http://localhost:${port}`
}

/**
 * Accumulate cost and turn metrics from a session_end event into the session's totals.
 * Called each time a Claude Code run finishes (initial + iterate runs).
 */
function accumulateSessionCost(config: ServerConfig, sessionId: string, event: EngineEvent): void {
	if (event.type !== "session_end") return
	const { cost_usd, num_turns, duration_ms } = event
	if (cost_usd == null && num_turns == null && duration_ms == null) return

	const existing = config.sessions.get(sessionId)
	const updates: Partial<SessionInfo> = {}
	if (cost_usd != null) {
		updates.totalCostUsd = (existing?.totalCostUsd ?? 0) + cost_usd
	}
	if (num_turns != null) {
		updates.totalTurns = (existing?.totalTurns ?? 0) + num_turns
	}
	if (duration_ms != null) {
		updates.totalDurationMs = (existing?.totalDurationMs ?? 0) + duration_ms
	}
	config.sessions.update(sessionId, updates)
	console.log(
		`[session:${sessionId}] Cost: $${updates.totalCostUsd?.toFixed(4) ?? "?"} (${updates.totalTurns ?? "?"} turns)`,
	)
}

/**
 * Create a Claude Code bridge for a session.
 * Spawns `claude` CLI with stream-json I/O inside the sandbox.
 */
function createClaudeCodeBridge(
	config: ServerConfig,
	sessionId: string,
	claudeConfig: ClaudeCodeDockerConfig | ClaudeCodeSpritesConfig,
): SessionBridge {
	const conn = sessionStream(config, sessionId)
	let bridge: SessionBridge

	if (config.sandbox.runtime === "sprites") {
		const spritesProvider = config.sandbox as SpritesSandboxProviderType
		const sprite = spritesProvider.getSpriteObject(sessionId)
		if (!sprite) {
			throw new Error(`No Sprites sandbox object for session ${sessionId}`)
		}
		bridge = new ClaudeCodeSpritesBridge(sessionId, conn, sprite, claudeConfig)
	} else {
		// Docker (default for claude-code mode)
		const dockerProvider = config.sandbox as DockerSandboxProviderType
		const containerId = dockerProvider.getContainerId(sessionId)
		if (!containerId) {
			throw new Error(`No Docker container found for session ${sessionId}`)
		}
		bridge = new ClaudeCodeDockerBridge(
			sessionId,
			conn,
			containerId,
			claudeConfig as ClaudeCodeDockerConfig,
		)
	}

	closeBridge(sessionId)
	bridges.set(sessionId, bridge)
	return bridge
}

/** Close and remove a bridge */
function closeBridge(sessionId: string): void {
	const bridge = bridges.get(sessionId)
	if (bridge) {
		bridge.close()
		bridges.delete(sessionId)
	}
}

/**
 * Detect git operations from natural language prompts.
 * Returns structured gitOp fields if matched, null otherwise.
 */
function detectGitOp(
	request: string,
): { gitOp: string; gitMessage?: string; gitPrTitle?: string; gitPrBody?: string } | null {
	const lower = request.toLowerCase().trim()

	// Commit: "commit", "commit the code", "commit changes", "commit with message ..."
	if (/^(git\s+)?commit\b/.test(lower) || /^save\s+(my\s+)?(changes|progress|work)\b/.test(lower)) {
		// Extract commit message after "commit" keyword, or after "message:" / "msg:"
		const msgMatch = request.match(
			/(?:commit\s+(?:with\s+(?:message\s+)?)?|message:\s*|msg:\s*)["']?(.+?)["']?\s*$/i,
		)
		const message = msgMatch?.[1]?.replace(/^(the\s+)?(code|changes)\s*/i, "").trim()
		return { gitOp: "commit", gitMessage: message || undefined }
	}

	// Push: "push", "push to github", "push to remote", "git push"
	if (/^(git\s+)?push\b/.test(lower)) {
		return { gitOp: "push" }
	}

	// Create PR: "create pr", "open pr", "make pr", "create pull request"
	if (/^(create|open|make)\s+(a\s+)?(pr|pull\s*request)\b/.test(lower)) {
		// Try to extract title after the PR keyword
		const titleMatch = request.match(
			/(?:pr|pull\s*request)\s+(?:(?:titled?|called|named)\s+)?["']?(.+?)["']?\s*$/i,
		)
		return { gitOp: "create-pr", gitPrTitle: titleMatch?.[1] || undefined }
	}

	return null
}

/**
 * Map a Claude Code hook event JSON payload to an EngineEvent.
 *
 * After Phase 1 renames, the mapping is nearly 1:1. Claude Code passes
 * hook data on stdin as JSON with a `hook_event_name` field.
 *
 * Returns null for unknown hook types (caller should silently skip).
 */
function mapHookToEngineEvent(body: Record<string, unknown>): EngineEvent | null {
	const hookName = body.hook_event_name as string | undefined
	const now = ts()

	switch (hookName) {
		case "SessionStart":
			return {
				type: "session_start",
				session_id: (body.session_id as string) || "",
				cwd: body.cwd as string | undefined,
				ts: now,
			}

		case "PreToolUse": {
			const toolName = (body.tool_name as string) || "unknown"
			const toolUseId = (body.tool_use_id as string) || `hook_${Date.now()}`
			const toolInput = (body.tool_input as Record<string, unknown>) || {}

			if (toolName === "TodoWrite") {
				return {
					type: "todo_write",
					tool_use_id: toolUseId,
					todos:
						(toolInput.todos as Array<{
							id: string
							content: string
							status: string
							priority?: string
						}>) || [],
					ts: now,
				}
			}

			if (toolName === "AskUserQuestion") {
				const questions = toolInput.questions as
					| Array<{
							question: string
							header?: string
							options?: Array<{ label: string; description?: string }>
							multiSelect?: boolean
					  }>
					| undefined
				const firstQuestion = questions?.[0]
				return {
					type: "ask_user_question",
					tool_use_id: toolUseId,
					question: firstQuestion?.question || (toolInput.question as string) || "",
					options: firstQuestion?.options as
						| Array<{ label: string; description?: string }>
						| undefined,
					questions: questions ?? undefined,
					ts: now,
				}
			}

			return {
				type: "pre_tool_use",
				tool_name: toolName,
				tool_use_id: toolUseId,
				tool_input: toolInput,
				ts: now,
			}
		}

		case "PostToolUse":
			return {
				type: "post_tool_use",
				tool_use_id: (body.tool_use_id as string) || "",
				tool_name: body.tool_name as string | undefined,
				tool_response: (body.tool_response as string) || "",
				ts: now,
			}

		case "PostToolUseFailure":
			return {
				type: "post_tool_use_failure",
				tool_use_id: (body.tool_use_id as string) || "",
				tool_name: (body.tool_name as string) || "unknown",
				error: (body.error as string) || "Unknown error",
				ts: now,
			}

		case "Stop":
			return {
				type: "assistant_message",
				text: (body.last_assistant_message as string) || "",
				ts: now,
			}

		case "SessionEnd": {
			const endEvent: EngineEvent = {
				type: "session_end",
				success: true,
				ts: now,
			}
			// Claude Code SessionEnd hook may include session stats
			const session = body.session as Record<string, unknown> | undefined
			if (session) {
				if (typeof session.cost_usd === "number") endEvent.cost_usd = session.cost_usd
				if (typeof session.num_turns === "number") endEvent.num_turns = session.num_turns
				if (typeof session.duration_ms === "number") endEvent.duration_ms = session.duration_ms
				if (typeof session.duration_api_ms === "number")
					endEvent.duration_api_ms = session.duration_api_ms
			}
			return endEvent
		}

		case "UserPromptSubmit":
			return {
				type: "user_prompt",
				message: (body.prompt as string) || "",
				ts: now,
			}

		case "SubagentStart":
		case "SubagentStop":
			return {
				type: "log",
				level: "task",
				message: `${hookName}: ${(body.agent_type as string) || "agent"}`,
				ts: now,
			}

		default:
			return null
	}
}

export function createApp(config: ServerConfig) {
	const app = new Hono()

	// CORS for local development
	app.use("*", cors({ origin: "*" }))

	// --- API Routes ---

	// Health check
	app.get("/api/health", (c) => {
		const checks: Record<string, string> = {}
		let healthy = true

		// Stream config
		if (config.streamConfig.url && config.streamConfig.serviceId && config.streamConfig.secret) {
			checks.streams = "ok"
		} else {
			checks.streams = "error"
			healthy = false
		}

		// Sandbox runtime
		checks.sandbox = config.sandbox.runtime

		return c.json({ healthy, checks }, healthy ? 200 : 503)
	})

	// Provision Electric Cloud resources via the Claim API
	app.post("/api/provision-electric", async (c) => {
		try {
			const result = await provisionElectricResources()
			return c.json({
				sourceId: result.source_id,
				secret: result.secret,
				databaseUrl: result.DATABASE_URL,
				electricUrl: DEFAULT_ELECTRIC_URL,
				claimId: result.claimId,
				claimUrl: getClaimUrl(result.claimId),
			})
		} catch (err) {
			const message = err instanceof Error ? err.message : "Provisioning failed"
			console.error("[provision-electric] Error:", message)
			return c.json({ error: message }, 500)
		}
	})

	// --- Session Token Auth Middleware ---
	// Protects session-scoped endpoints. Hook endpoints and creation routes are exempt.
	// Hono's wildcard middleware matches creation routes like /api/sessions/local as
	// :id="local", so we must explicitly skip those.

	const authExemptIds = new Set(["local", "auto", "resume"])
	// Hook-event auth is handled in the endpoint handler via validateHookToken

	/** Extract session token from Authorization header or query param. */
	function extractToken(c: {
		req: {
			header: (name: string) => string | undefined
			query: (name: string) => string | undefined
		}
	}): string | undefined {
		const authHeader = c.req.header("Authorization")
		if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7)
		return c.req.query("token") ?? undefined
	}

	// Protect /api/sessions/:id/* and /api/sessions/:id
	app.use("/api/sessions/:id/*", async (c, next) => {
		const id = c.req.param("id")
		if (authExemptIds.has(id)) return next()

		const subPath = c.req.path.replace(/^\/api\/sessions\/[^/]+/, "")

		// Hook-event uses a purpose-scoped hook token (validated in the handler)
		if (subPath === "/hook-event") return next()

		const token = extractToken(c)
		if (!token || !validateSessionToken(config.streamConfig.secret, id, token)) {
			return c.json({ error: "Invalid or missing session token" }, 401)
		}
		return next()
	})

	app.use("/api/sessions/:id", async (c, next) => {
		const id = c.req.param("id")
		if (authExemptIds.has(id)) return next()
		if (c.req.method !== "GET" && c.req.method !== "DELETE") return next()

		const token = extractToken(c)
		if (!token || !validateSessionToken(config.streamConfig.secret, id, token)) {
			return c.json({ error: "Invalid or missing session token" }, 401)
		}
		return next()
	})

	// Get single session (from in-memory active sessions)
	app.get("/api/sessions/:id", (c) => {
		const session = config.sessions.get(c.req.param("id"))
		if (!session) return c.json({ error: "Session not found" }, 404)
		return c.json(session)
	})

	// --- Local Claude Code session endpoints ---

	// Create a local session (no sandbox, just a stream + session index entry).
	// Used for the hook-to-stream bridge: Claude Code running locally forwards
	// hook events to the web UI via POST /api/sessions/:id/hook-event.
	app.post("/api/sessions/local", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { description?: string }

		const sessionId = crypto.randomUUID()

		// Create the durable stream
		const conn = sessionStream(config, sessionId)
		try {
			await DurableStream.create({
				url: conn.url,
				headers: conn.headers,
				contentType: "application/json",
			})
		} catch (err) {
			console.error(`[local-session] Failed to create durable stream:`, err)
			return c.json({ error: "Failed to create event stream" }, 500)
		}

		// Record session (no sandbox, no appPort)
		const session: SessionInfo = {
			id: sessionId,
			projectName: "local-session",
			sandboxProjectDir: "",
			description: body.description || "Local Claude Code session",
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: "running",
		}
		config.sessions.add(session)

		// Pre-create a bridge so hook-event can emit to it immediately
		getOrCreateBridge(config, sessionId)

		const sessionToken = deriveSessionToken(config.streamConfig.secret, sessionId)
		const hookToken = deriveHookToken(config.streamConfig.secret, sessionId)
		console.log(`[local-session] Created session: ${sessionId}`)
		return c.json({ sessionId, sessionToken, hookToken }, 201)
	})

	// Auto-register a local session on first hook event (SessionStart).
	// Eliminates the manual `curl POST /api/sessions/local` step.
	app.post("/api/sessions/auto", async (c) => {
		const body = (await c.req.json()) as Record<string, unknown>
		const hookName = body.hook_event_name as string | undefined

		if (hookName !== "SessionStart") {
			return c.json({ error: "Only SessionStart events can auto-register a session" }, 400)
		}

		const sessionId = crypto.randomUUID()

		// Create the durable stream
		const conn = sessionStream(config, sessionId)
		try {
			await DurableStream.create({
				url: conn.url,
				headers: conn.headers,
				contentType: "application/json",
			})
		} catch (err) {
			console.error(`[auto-session] Failed to create durable stream:`, err)
			return c.json({ error: "Failed to create event stream" }, 500)
		}

		// Derive project name from cwd
		const cwd = body.cwd as string | undefined
		const projectName = cwd ? path.basename(cwd) : "local-session"
		const claudeSessionId = body.session_id as string | undefined

		const session: SessionInfo = {
			id: sessionId,
			projectName,
			sandboxProjectDir: cwd || "",
			description: `Local session: ${projectName}`,
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: "running",
			claudeSessionId: claudeSessionId || undefined,
		}
		config.sessions.add(session)

		// Create bridge and emit the SessionStart event
		const bridge = getOrCreateBridge(config, sessionId)
		const hookEvent = mapHookToEngineEvent(body)
		if (hookEvent) {
			await bridge.emit(hookEvent)
		}

		const sessionToken = deriveSessionToken(config.streamConfig.secret, sessionId)
		const hookToken = deriveHookToken(config.streamConfig.secret, sessionId)
		console.log(`[auto-session] Created session: ${sessionId} (project: ${projectName})`)
		return c.json({ sessionId, sessionToken, hookToken }, 201)
	})

	// Receive a hook event from Claude Code (via forward.sh) and write it
	// to the session's durable stream as an EngineEvent.
	// For AskUserQuestion, this blocks until the user answers in the web UI.
	app.post("/api/sessions/:id/hook-event", async (c) => {
		const sessionId = c.req.param("id")

		// Validate hook token (scoped per-session, separate from session token)
		const token = extractToken(c)
		if (!token || !validateHookToken(config.streamConfig.secret, sessionId, token)) {
			return c.json({ error: "Invalid or missing hook token" }, 401)
		}

		const body = (await c.req.json()) as Record<string, unknown>

		const bridge = getOrCreateBridge(config, sessionId)

		// Map Claude Code hook JSON → EngineEvent
		const hookEvent = mapHookToEngineEvent(body)
		if (!hookEvent) {
			return c.json({ ok: true }) // Unknown hook type — silently skip
		}

		// For Docker/Sprites bridge sessions, the stream-json parser already emits
		// events to the durable stream. Only emit from hooks for hosted (local) bridges
		// to avoid duplicate events.
		const isClaudeCodeBridge =
			bridge instanceof ClaudeCodeDockerBridge || bridge instanceof ClaudeCodeSpritesBridge
		if (!isClaudeCodeBridge) {
			try {
				await bridge.emit(hookEvent)
			} catch (err) {
				console.error(`[hook-event] Failed to emit:`, err)
				return c.json({ error: "Failed to write event" }, 500)
			}
		}

		// Bump lastActiveAt on every hook event
		config.sessions.update(sessionId, {})

		// SessionEnd: mark session complete and close the bridge
		if (hookEvent.type === "session_end") {
			accumulateSessionCost(config, sessionId, hookEvent)
			if (!isClaudeCodeBridge) {
				config.sessions.update(sessionId, { status: "complete" })
				closeBridge(sessionId)
			}
			return c.json({ ok: true })
		}

		// AskUserQuestion: block until the user answers via the web UI
		if (hookEvent.type === "ask_user_question") {
			const toolUseId = hookEvent.tool_use_id
			console.log(`[hook-event] Blocking for ask_user_question gate: ${toolUseId}`)
			try {
				const gateTimeout = 5 * 60 * 1000 // 5 minutes
				const result = await Promise.race([
					createGate<{ answers: Record<string, string> }>(
						sessionId,
						`ask_user_question:${toolUseId}`,
					),
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error("AskUserQuestion gate timed out")), gateTimeout),
					),
				])
				console.log(`[hook-event] ask_user_question gate resolved: ${toolUseId}`)
				return c.json({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "allow",
						updatedInput: {
							questions: (body.tool_input as Record<string, unknown>)?.questions,
							answers: result.answers,
						},
					},
				})
			} catch (err) {
				console.error(`[hook-event] ask_user_question gate error:`, err)
				return c.json({ ok: true }) // Don't block Claude Code on timeout
			}
		}

		return c.json({ ok: true })
	})

	// --- Unified Hook Endpoint (transcript_path correlation) ---

	// Single endpoint for all Claude Code hook events. Uses transcript_path
	// from the hook JSON as the correlation key — stable across resume/compact,
	// changes on /clear. Replaces the need for client-side session tracking.
	app.post("/api/hook", async (c) => {
		const body = (await c.req.json()) as Record<string, unknown>
		const transcriptPath = body.transcript_path as string | undefined

		// Look up or create session via transcript_path
		let sessionId: string | undefined
		if (transcriptPath) {
			sessionId = config.sessions.getByTranscript(transcriptPath)
		}

		if (!sessionId) {
			// Check inflight creation to prevent duplicate sessions from concurrent hooks
			if (transcriptPath && inflightHookCreations.has(transcriptPath)) {
				// Another request is already creating a session for this transcript — wait for it
				sessionId = await inflightHookCreations.get(transcriptPath)
			}
		}

		if (!sessionId) {
			// Create a new session (with inflight guard)
			const createPromise = (async () => {
				const newId = crypto.randomUUID()

				// Create the durable stream
				const conn = sessionStream(config, newId)
				try {
					await DurableStream.create({
						url: conn.url,
						headers: conn.headers,
						contentType: "application/json",
					})
				} catch (err) {
					console.error(`[hook] Failed to create durable stream:`, err)
					throw err
				}

				// Derive project name from cwd
				const cwd = body.cwd as string | undefined
				const projectName = cwd ? path.basename(cwd) : "local-session"

				const session: SessionInfo = {
					id: newId,
					projectName,
					sandboxProjectDir: cwd || "",
					description: `Local session: ${projectName}`,
					createdAt: new Date().toISOString(),
					lastActiveAt: new Date().toISOString(),
					status: "running",
				}
				config.sessions.add(session)

				// Durably map transcript_path → session
				if (transcriptPath) {
					config.sessions.mapTranscript(transcriptPath, newId)
				}

				console.log(
					`[hook] Created session: ${newId} (project: ${session.projectName}, transcript: ${transcriptPath ?? "none"})`,
				)
				return newId
			})()

			if (transcriptPath) {
				inflightHookCreations.set(transcriptPath, createPromise)
			}
			try {
				sessionId = await createPromise
			} catch {
				return c.json({ error: "Failed to create event stream" }, 500)
			} finally {
				if (transcriptPath) {
					inflightHookCreations.delete(transcriptPath)
				}
			}
		}

		// Ensure bridge exists
		const bridge = getOrCreateBridge(config, sessionId)

		// On SessionStart (resume/compact), re-activate the session
		const hookName = body.hook_event_name as string | undefined
		if (hookName === "SessionStart") {
			const session = config.sessions.get(sessionId)
			if (session && session.status !== "running") {
				config.sessions.update(sessionId, { status: "running" })
			}
		}

		// Map hook JSON → EngineEvent
		const hookEvent = mapHookToEngineEvent(body)
		if (!hookEvent) {
			return c.json({ ok: true, sessionId })
		}

		try {
			await bridge.emit(hookEvent)
		} catch (err) {
			console.error(`[hook] Failed to emit:`, err)
			return c.json({ error: "Failed to write event" }, 500)
		}

		// Bump lastActiveAt
		config.sessions.update(sessionId, {})

		// SessionEnd: mark complete and close bridge (keep mapping for potential re-open)
		if (hookEvent.type === "session_end") {
			accumulateSessionCost(config, sessionId, hookEvent)
			config.sessions.update(sessionId, { status: "complete" })
			closeBridge(sessionId)
			return c.json({ ok: true, sessionId })
		}

		// AskUserQuestion: block until the user answers via the web UI
		if (hookEvent.type === "ask_user_question") {
			const toolUseId = hookEvent.tool_use_id
			console.log(`[hook] Blocking for ask_user_question gate: ${toolUseId}`)
			try {
				const gateTimeout = 5 * 60 * 1000
				const result = await Promise.race([
					createGate<{ answers: Record<string, string> }>(
						sessionId,
						`ask_user_question:${toolUseId}`,
					),
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error("AskUserQuestion gate timed out")), gateTimeout),
					),
				])
				console.log(`[hook] ask_user_question gate resolved: ${toolUseId}`)
				return c.json({
					sessionId,
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "allow",
						updatedInput: {
							questions: (body.tool_input as Record<string, unknown>)?.questions,
							answers: result.answers,
						},
					},
				})
			} catch (err) {
				console.error(`[hook] ask_user_question gate error:`, err)
				return c.json({ ok: true, sessionId })
			}
		}

		return c.json({ ok: true, sessionId })
	})

	// --- Hook Setup Installer ---

	// Returns a shell script that installs forward.sh and configures Claude Code hooks
	// in the current project directory (.claude/hooks/ and .claude/settings.local.json).
	// Usage: cd <project> && curl -s http://localhost:4400/api/hooks/setup | bash
	app.get("/api/hooks/setup", (c) => {
		const port = config.port
		const script = `#!/bin/bash
# Electric Agent — Claude Code hook installer (project-scoped)
# Installs the hook forwarder into the current project's .claude/ directory.

set -e

HOOKS_DIR=".claude/hooks"
SETTINGS_FILE=".claude/settings.local.json"
FORWARD_SH="\${HOOKS_DIR}/forward.sh"
EA_PORT="${port}"

mkdir -p "\${HOOKS_DIR}"

# Write the forwarder script
cat > "\${FORWARD_SH}" << 'HOOKEOF'
#!/bin/bash
# Forward Claude Code hook events to Electric Agent studio.
# Installed by: curl -s http://localhost:EA_PORT/api/hooks/setup | bash

EA_PORT="\${EA_PORT:-EA_PORT_PLACEHOLDER}"
BODY="$(cat)"

RESPONSE=$(curl -s -X POST "http://localhost:\${EA_PORT}/api/hook" \\
  -H "Content-Type: application/json" \\
  -d "\${BODY}" \\
  --max-time 360 \\
  --connect-timeout 2 \\
  2>/dev/null)

# If the response contains hookSpecificOutput, print it so Claude Code reads it
if echo "\${RESPONSE}" | grep -q '"hookSpecificOutput"'; then
  echo "\${RESPONSE}"
fi

exit 0
HOOKEOF

# Replace placeholder with actual port
sed -i.bak "s/EA_PORT_PLACEHOLDER/${port}/" "\${FORWARD_SH}" && rm -f "\${FORWARD_SH}.bak"
chmod +x "\${FORWARD_SH}"

# Merge hook config into project-level settings.local.json
HOOK_ENTRY="\${FORWARD_SH}"

if command -v node > /dev/null 2>&1; then
  node -e "
const fs = require('fs');
const file = process.argv[1];
const hook = process.argv[2];
let settings = {};
try { settings = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
if (!settings.hooks) settings.hooks = {};
const events = ['PreToolUse','PostToolUse','PostToolUseFailure','Stop','SessionStart','SessionEnd','UserPromptSubmit','SubagentStart','SubagentStop'];
for (const ev of events) {
  if (!settings.hooks[ev]) settings.hooks[ev] = [];
  const arr = settings.hooks[ev];
  if (!arr.some(g => g.hooks && g.hooks.some(h => h.command === hook))) {
    arr.push({ hooks: [{ type: 'command', command: hook }] });
  }
}
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\\\\n');
" "\${SETTINGS_FILE}" "\${HOOK_ENTRY}"
else
  echo "Warning: node not found. Please add the hook manually to \${SETTINGS_FILE}"
  echo "See: https://docs.anthropic.com/en/docs/claude-code/hooks"
  exit 1
fi

echo ""
echo "Electric Agent hooks installed in project: $(pwd)"
echo "  Forwarder: $(pwd)/\${FORWARD_SH}"
echo "  Settings:  $(pwd)/\${SETTINGS_FILE}"
echo "  Server:    http://localhost:\${EA_PORT}"
echo ""
echo "Start claude in this project — the session will appear in the studio UI."
`
		return c.text(script, 200, { "Content-Type": "text/plain" })
	})

	// Start new project
	app.post("/api/sessions", async (c) => {
		const body = (await c.req.json()) as {
			description: string
			name?: string
			baseDir?: string
			freeform?: boolean
			apiKey?: string
			oauthToken?: string
			ghToken?: string
		}

		if (!body.description) {
			return c.json({ error: "description is required" }, 400)
		}

		const sessionId = crypto.randomUUID()
		const inferredName =
			body.name ||
			body.description
				.slice(0, 40)
				.replace(/[^a-z0-9]+/gi, "-")
				.replace(/^-|-$/g, "")
				.toLowerCase()
		const baseDir = body.baseDir || process.cwd()
		const { projectName } = resolveProjectDir(baseDir, inferredName)

		console.log(`[session] Creating new session: id=${sessionId} project=${projectName}`)

		// Create the durable stream
		const conn = sessionStream(config, sessionId)
		try {
			await DurableStream.create({
				url: conn.url,
				headers: conn.headers,
				contentType: "application/json",
			})
			console.log(`[session] Durable stream created: ${conn.url}`)
		} catch (err) {
			console.error(`[session] Failed to create durable stream:`, err)
			return c.json({ error: "Failed to create event stream" }, 500)
		}

		// Create the initial session bridge (may be replaced with stdio bridge after sandbox creation)
		let bridge: SessionBridge = getOrCreateBridge(config, sessionId)

		// Record session
		const sandboxProjectDir = `/home/agent/workspace/${projectName}`
		const session: SessionInfo = {
			id: sessionId,
			projectName,
			sandboxProjectDir,
			description: body.description,
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: "running",
		}
		config.sessions.add(session)

		// Write user prompt to the stream so it shows in the UI
		await bridge.emit({ type: "user_prompt", message: body.description, ts: ts() })

		// Freeform sessions skip the infra config gate — no Electric/DB setup needed
		let ghAccounts: { login: string; type: "user" | "org" }[] = []
		if (!body.freeform) {
			// Gather GitHub accounts for the merged setup gate
			// Only check if the client provided a token — never fall back to server-side GH_TOKEN
			if (body.ghToken && isGhAuthenticated(body.ghToken)) {
				try {
					ghAccounts = ghListAccounts(body.ghToken)
				} catch {
					// gh not available — no repo setup
				}
			}

			// Emit combined infra + repo setup gate
			await bridge.emit({
				type: "infra_config_prompt",
				projectName,
				ghAccounts,
				runtime: config.sandbox.runtime,
				ts: ts(),
			})
		}

		// Launch async flow: wait for setup gate → create sandbox → start agent
		const asyncFlow = async () => {
			// 1. Wait for combined infra + repo config (skip for freeform)
			let infra: InfraConfig
			let repoConfig: {
				account: string
				repoName: string
				visibility: "public" | "private"
			} | null = null

			let claimId: string | undefined
			if (body.freeform) {
				// Freeform sessions don't need Electric infrastructure
				infra = { mode: "none" }
				console.log(`[session:${sessionId}] Freeform session — skipping infra gate`)
			} else {
				console.log(`[session:${sessionId}] Waiting for infra_config gate...`)
				try {
					const gateValue = await createGate<
						InfraConfig & {
							repoAccount?: string
							repoName?: string
							repoVisibility?: "public" | "private"
							claimId?: string
						}
					>(sessionId, "infra_config")

					console.log(`[session:${sessionId}] Infra gate resolved: mode=${gateValue.mode}`)

					if (gateValue.mode === "cloud" || gateValue.mode === "claim") {
						// Normalize claim → cloud for the sandbox layer (same env vars)
						infra = {
							mode: "cloud",
							databaseUrl: gateValue.databaseUrl,
							electricUrl: gateValue.electricUrl,
							sourceId: gateValue.sourceId,
							secret: gateValue.secret,
						}
						if (gateValue.mode === "claim") {
							claimId = gateValue.claimId
						}
					} else {
						infra = { mode: "local" }
					}

					// Extract repo config if provided
					if (gateValue.repoAccount && gateValue.repoName?.trim()) {
						repoConfig = {
							account: gateValue.repoAccount,
							repoName: gateValue.repoName,
							visibility: gateValue.repoVisibility ?? "private",
						}
						config.sessions.update(sessionId, {
							git: {
								branch: "main",
								remoteUrl: null,
								repoName: `${repoConfig.account}/${repoConfig.repoName}`,
								repoVisibility: repoConfig.visibility,
								lastCommitHash: null,
								lastCommitMessage: null,
								lastCheckpointAt: null,
							},
						})
					}
				} catch (err) {
					console.log(`[session:${sessionId}] Infra gate error (defaulting to local):`, err)
					infra = { mode: "local" }
				}
			}

			// 2. Create sandbox — emit progress events so the UI shows feedback
			await bridge.emit({
				type: "log",
				level: "build",
				message: `Creating ${config.sandbox.runtime} sandbox...`,
				ts: ts(),
			})

			console.log(
				`[session:${sessionId}] Creating sandbox: runtime=${config.sandbox.runtime} project=${projectName}`,
			)
			const handle = await config.sandbox.create(sessionId, {
				projectName,
				infra,
				apiKey: body.apiKey,
				oauthToken: body.oauthToken,
				ghToken: body.ghToken,
			})
			console.log(
				`[session:${sessionId}] Sandbox created: projectDir=${handle.projectDir} port=${handle.port} previewUrl=${handle.previewUrl ?? "none"}`,
			)

			await bridge.emit({
				type: "log",
				level: "done",
				message: `Sandbox ready (${config.sandbox.runtime})`,
				ts: ts(),
			})

			config.sessions.update(sessionId, {
				appPort: handle.port,
				sandboxProjectDir: handle.projectDir,
				previewUrl: handle.previewUrl,
				...(claimId ? { claimId } : {}),
			})

			// 3. Write CLAUDE.md and create a ClaudeCode bridge.
			{
				console.log(`[session:${sessionId}] Setting up Claude Code bridge...`)

				if (!body.freeform) {
					// Copy pre-scaffolded project from the image and customize per-session
					await bridge.emit({
						type: "log",
						level: "build",
						message: "Setting up project...",
						ts: ts(),
					})
					try {
						if (config.sandbox.runtime === "docker") {
							// Docker: copy the pre-built scaffold base (baked into the image)
							await config.sandbox.exec(handle, `cp -r /opt/scaffold-base '${handle.projectDir}'`)
							await config.sandbox.exec(
								handle,
								`cd '${handle.projectDir}' && sed -i 's/"name": "scaffold-base"/"name": "${projectName}"/' package.json`,
							)
						} else {
							// Sprites: run scaffold from globally installed electric-agent
							await config.sandbox.exec(
								handle,
								`source /etc/profile.d/npm-global.sh 2>/dev/null; electric-agent scaffold '${handle.projectDir}' --name '${projectName}' --skip-git`,
							)
						}
						console.log(`[session:${sessionId}] Project setup complete`)
						await bridge.emit({
							type: "log",
							level: "done",
							message: "Project ready",
							ts: ts(),
						})

						// Log the agent package version installed in the sandbox
						try {
							const agentVersion = (
								await config.sandbox.exec(handle, "electric-agent --version 2>/dev/null | tail -1")
							).trim()
							await bridge.emit({
								type: "log",
								level: "verbose",
								message: `electric-agent@${agentVersion}`,
								ts: ts(),
							})
						} catch {
							// Non-critical — don't block session creation
						}
					} catch (err) {
						console.error(`[session:${sessionId}] Project setup failed:`, err)
						await bridge.emit({
							type: "log",
							level: "error",
							message: `Project setup failed: ${err instanceof Error ? err.message : "unknown"}`,
							ts: ts(),
						})
					}

					// Write CLAUDE.md to the sandbox workspace.
					// Our generator includes hardcoded playbook paths and reading order
					// so we don't depend on @tanstack/intent generating a skill block.
					const claudeMd = generateClaudeMd({
						description: body.description,
						projectName,
						projectDir: handle.projectDir,
						runtime: config.sandbox.runtime,
						...(repoConfig
							? {
									git: {
										mode: "create" as const,
										repoName: `${repoConfig.account}/${repoConfig.repoName}`,
										visibility: repoConfig.visibility,
									},
								}
							: {}),
					})
					try {
						await config.sandbox.exec(
							handle,
							`cat > '${handle.projectDir}/CLAUDE.md' << 'CLAUDEMD_EOF'\n${claudeMd}\nCLAUDEMD_EOF`,
						)
					} catch (err) {
						console.error(`[session:${sessionId}] Failed to write CLAUDE.md:`, err)
					}

					// Ensure the create-app skill is present in the project.
					// The npm-installed electric-agent may be an older version that
					// doesn't include .claude/skills/ in its template directory.
					if (createAppSkillContent) {
						try {
							const skillDir = `${handle.projectDir}/.claude/skills/create-app`
							const skillB64 = Buffer.from(createAppSkillContent).toString("base64")
							await config.sandbox.exec(
								handle,
								`mkdir -p '${skillDir}' && echo '${skillB64}' | base64 -d > '${skillDir}/SKILL.md'`,
							)
						} catch (err) {
							console.error(`[session:${sessionId}] Failed to write create-app skill:`, err)
						}
					}
				}

				// Ensure the room-messaging skill is present so agents have
				// persistent access to the multi-agent protocol reference.
				if (roomMessagingSkillContent) {
					try {
						const skillDir = `${handle.projectDir}/.claude/skills/room-messaging`
						const skillB64 = Buffer.from(roomMessagingSkillContent).toString("base64")
						await config.sandbox.exec(
							handle,
							`mkdir -p '${skillDir}' && echo '${skillB64}' | base64 -d > '${skillDir}/SKILL.md'`,
						)
					} catch (err) {
						console.error(`[session:${sessionId}] Failed to write room-messaging skill:`, err)
					}
				}

				const sessionPrompt = body.freeform ? body.description : `/create-app ${body.description}`
				const sessionHookToken = deriveHookToken(config.streamConfig.secret, sessionId)
				const claudeConfig: ClaudeCodeDockerConfig | ClaudeCodeSpritesConfig =
					config.sandbox.runtime === "sprites"
						? {
								prompt: sessionPrompt,
								cwd: handle.projectDir,
								studioUrl: resolveStudioUrl(config.port),
								hookToken: sessionHookToken,
							}
						: {
								prompt: sessionPrompt,
								cwd: handle.projectDir,
								studioPort: config.port,
								hookToken: sessionHookToken,
							}
				bridge = createClaudeCodeBridge(config, sessionId, claudeConfig)
			}

			// 4. Log repo config
			if (repoConfig) {
				await bridge.emit({
					type: "log",
					level: "done",
					message: `GitHub repo: ${repoConfig.account}/${repoConfig.repoName} (${repoConfig.visibility}) — will be created after scaffolding`,
					ts: ts(),
				})
			}

			// 5. Start listening for agent events via the bridge

			// Track Claude Code session ID and cost from agent events
			bridge.onAgentEvent((event) => {
				if (event.type === "session_start") {
					const ccSessionId = (event as EngineEvent & { session_id?: string }).session_id
					console.log(`[session:${sessionId}] Captured Claude Code session ID: ${ccSessionId}`)
					if (ccSessionId) {
						config.sessions.update(sessionId, { lastCoderSessionId: ccSessionId })
					}
				}
				if (event.type === "session_end") {
					accumulateSessionCost(config, sessionId, event)
				}
			})

			bridge.onComplete(async (success) => {
				const updates: Partial<SessionInfo> = {
					status: success ? "complete" : "error",
				}
				try {
					const gs = await config.sandbox.gitStatus(handle, handle.projectDir)
					if (gs.initialized) {
						const existing = config.sessions.get(sessionId)
						updates.git = {
							branch: gs.branch ?? "main",
							remoteUrl: existing?.git?.remoteUrl ?? null,
							repoName: existing?.git?.repoName ?? null,
							repoVisibility: existing?.git?.repoVisibility,
							lastCommitHash: gs.lastCommitHash ?? null,
							lastCommitMessage: gs.lastCommitMessage ?? null,
							lastCheckpointAt: existing?.git?.lastCheckpointAt ?? null,
						}
					}
				} catch {
					// Container may already be stopped
				}
				config.sessions.update(sessionId, updates)

				// Check if the app is running after completion
				// and emit app_status so the UI shows the preview link
				if (success) {
					try {
						const appRunning = await config.sandbox.isAppRunning(handle)
						if (appRunning) {
							await bridge.emit({
								type: "app_status",
								status: "running",
								port: handle.port ?? session.appPort,
								previewUrl: handle.previewUrl ?? session.previewUrl,
								ts: ts(),
							})
						}
					} catch {
						// Container may already be stopped
					}
				}
			})

			// Show the command being sent to Claude Code
			await bridge.emit({
				type: "log",
				level: "build",
				message: body.freeform
					? `Running: claude "${body.description}"`
					: `Running: claude "/create-app ${body.description}"`,
				ts: ts(),
			})

			console.log(`[session:${sessionId}] Starting bridge listener...`)
			await bridge.start()
			console.log(`[session:${sessionId}] Bridge started, sending 'new' command...`)

			// 5. Send the new command via the bridge
			await bridge.sendCommand({
				command: "new",
				description: body.description,
				projectName,
				baseDir: "/home/agent/workspace",
			})
			console.log(`[session:${sessionId}] Command sent, waiting for agent...`)
		}

		asyncFlow().catch(async (err) => {
			console.error(`[session:${sessionId}] Session creation flow failed:`, err)
			config.sessions.update(sessionId, { status: "error" })
			try {
				await bridge.emit({
					type: "log",
					level: "error",
					message: `Session failed: ${err instanceof Error ? err.message : String(err)}`,
					ts: ts(),
				})
			} catch {
				// Bridge may not be usable if the failure happened early
			}
		})

		const sessionToken = deriveSessionToken(config.streamConfig.secret, sessionId)
		return c.json({ sessionId, session, sessionToken }, 201)
	})

	// Send iteration request
	app.post("/api/sessions/:id/iterate", async (c) => {
		const sessionId = c.req.param("id")
		const session = config.sessions.get(sessionId)
		if (!session) return c.json({ error: "Session not found" }, 404)

		const body = (await c.req.json()) as { request: string }
		if (!body.request) {
			return c.json({ error: "request is required" }, 400)
		}

		// Intercept operational commands (start/stop/restart the app/server)
		const normalised = body.request
			.toLowerCase()
			.replace(/[^a-z ]/g, "")
			.trim()
		const appOrServer = /\b(app|server|dev server|dev|vite)\b/
		const isStartCmd = /^(start|run|launch|boot)\b/.test(normalised) && appOrServer.test(normalised)
		const isStopCmd =
			/^(stop|kill|shutdown|shut down)\b/.test(normalised) && appOrServer.test(normalised)
		const isRestartCmd = /^restart\b/.test(normalised) && appOrServer.test(normalised)

		if (isStartCmd || isStopCmd || isRestartCmd) {
			const bridge = getOrCreateBridge(config, sessionId)
			await bridge.emit({ type: "user_prompt", message: body.request, ts: ts() })

			try {
				const handle = config.sandbox.get(sessionId)
				if (isStopCmd) {
					if (handle && config.sandbox.isAlive(handle)) await config.sandbox.stopApp(handle)
					await bridge.emit({ type: "log", level: "done", message: "App stopped", ts: ts() })
				} else {
					if (!handle || !config.sandbox.isAlive(handle)) {
						return c.json({ error: "Container is not running" }, 400)
					}
					if (isRestartCmd) await config.sandbox.stopApp(handle)
					await config.sandbox.startApp(handle)
					await bridge.emit({
						type: "log",
						level: "done",
						message: "App started",
						ts: ts(),
					})
					await bridge.emit({
						type: "app_status",
						status: "running",
						port: session.appPort,
						previewUrl: session.previewUrl,
						ts: ts(),
					})
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Operation failed"
				await bridge.emit({ type: "log", level: "error", message: msg, ts: ts() })
			}
			return c.json({ ok: true })
		}

		// Intercept git commands (commit, push, create PR)
		const gitOp = detectGitOp(body.request)
		if (gitOp) {
			const bridge = getOrCreateBridge(config, sessionId)
			await bridge.emit({ type: "user_prompt", message: body.request, ts: ts() })

			const handle = config.sandbox.get(sessionId)
			if (!handle || !config.sandbox.isAlive(handle)) {
				return c.json({ error: "Container is not running" }, 400)
			}

			// Send git requests as user messages via Claude Code bridge
			await bridge.sendCommand({
				command: "iterate",
				request: body.request,
			})

			return c.json({ ok: true })
		}

		const handle = config.sandbox.get(sessionId)
		if (!handle || !config.sandbox.isAlive(handle)) {
			return c.json({ error: "Container is not running" }, 400)
		}

		// Write user prompt to the stream
		const bridge = getOrCreateBridge(config, sessionId)
		await bridge.emit({ type: "user_prompt", message: body.request, ts: ts() })

		config.sessions.update(sessionId, { status: "running" })

		await bridge.sendCommand({
			command: "iterate",
			projectDir: session.sandboxProjectDir || handle.projectDir,
			request: body.request,
			resumeSessionId: session.lastCoderSessionId,
		})

		return c.json({ ok: true })
	})

	// Respond to a gate (approval, clarification, continue, revision)
	app.post("/api/sessions/:id/respond", async (c) => {
		const sessionId = c.req.param("id")
		console.log(`[respond] incoming request for session=${sessionId}`)
		const body = (await c.req.json()) as Record<string, unknown>
		const gate = body.gate as string
		console.log(`[respond] gate=${gate} body=${JSON.stringify(body)}`)

		if (!gate) {
			return c.json({ error: "gate is required" }, 400)
		}

		// Client may pass a human-readable summary of the decision for replay display
		const summary = (body._summary as string) || undefined

		// Extract participant info from headers for gate attribution
		const participantId = c.req.header("X-Participant-Id")
		const participantName = c.req.header("X-Participant-Name")
		const resolvedBy: Participant | undefined =
			participantId && participantName
				? { id: participantId, displayName: participantName }
				: undefined

		// AskUserQuestion gates: try to resolve the blocking hook-event first.
		// If no gate is pending (Docker/Sprites bridge sessions create no gate),
		// fall through to the generic bridge.sendGateResponse() path below.
		if (gate === "ask_user_question") {
			const toolUseId = body.toolUseId as string
			if (!toolUseId) {
				return c.json({ error: "toolUseId is required for ask_user_question" }, 400)
			}
			// Accept either answers (Record<string, string>) or legacy answer (string)
			const answers: Record<string, string> =
				(body.answers as Record<string, string>) ??
				(body.answer ? { [(body.question as string) || "answer"]: body.answer as string } : {})
			const resolved = resolveGate(sessionId, `ask_user_question:${toolUseId}`, { answers })
			if (resolved) {
				// Hook session — gate was blocking, now resolved
				try {
					const bridge = getOrCreateBridge(config, sessionId)
					await bridge.emit({
						type: "gate_resolved",
						gate: "ask_user_question",
						summary,
						resolvedBy,
						ts: ts(),
					})
				} catch {
					// Non-critical
				}
				return c.json({ ok: true })
			}
			// No pending gate — fall through to bridge.sendGateResponse()
		}

		// Outbound message gates (room agent → room stream): resolved in-process
		if (gate === "outbound_message_gate") {
			const gateId = body.gateId as string
			const action = body.action as "approve" | "edit" | "drop"
			if (!gateId || !action) {
				return c.json({ error: "gateId and action are required for outbound_message_gate" }, 400)
			}
			const resolved = resolveGate(sessionId, gateId, {
				action,
				editedBody: body.editedBody as string | undefined,
			})
			if (resolved) {
				return c.json({ ok: true })
			}
			return c.json({ error: "No pending gate found" }, 404)
		}

		// Server-side gates are resolved in-process (they run on the server, not inside the container)
		const serverGates = new Set(["infra_config"])

		// Forward agent gate responses via the bridge
		if (!serverGates.has(gate)) {
			const bridge = bridges.get(sessionId)
			if (!bridge) {
				return c.json({ error: "No active bridge found" }, 404)
			}
			const { gate: _, _summary: _s, ...value } = body
			await bridge.sendGateResponse(gate, value as Record<string, unknown>)

			// Persist gate resolution for replay
			try {
				await bridge.emit({ type: "gate_resolved", gate, summary, resolvedBy, ts: ts() })
			} catch {
				// Non-critical
			}
			return c.json({ ok: true })
		}

		// Resolve in-process gate
		let value: unknown
		switch (gate) {
			case "infra_config":
				if (body.mode === "cloud" || body.mode === "claim") {
					value = {
						mode: body.mode,
						databaseUrl: body.databaseUrl,
						electricUrl: body.electricUrl,
						sourceId: body.sourceId,
						secret: body.secret,
						claimId: body.claimId,
						repoAccount: body.repoAccount,
						repoName: body.repoName,
						repoVisibility: body.repoVisibility,
					}
				} else {
					value = {
						mode: "local",
						repoAccount: body.repoAccount,
						repoName: body.repoName,
						repoVisibility: body.repoVisibility,
					}
				}
				break
			default:
				return c.json({ error: `Unknown gate: ${gate}` }, 400)
		}

		console.log(`[respond] session=${sessionId} gate=${gate} value=${JSON.stringify(value)}`)
		const resolved = resolveGate(sessionId, gate, value)
		if (!resolved) {
			console.log(`[respond] NO pending gate found for ${sessionId}:${gate}`)
			return c.json({ error: "No pending gate found" }, 404)
		}

		// Build structured details for the infra_config gate so the UI can
		// display them on both live sessions and session replay.
		let details: Record<string, string> | undefined
		if (gate === "infra_config") {
			const modeLabels: Record<string, string> = {
				claim: "Provisioned (Cloud)",
				local: "Local (Docker)",
				cloud: "Electric Cloud (BYO)",
			}
			details = { Infrastructure: modeLabels[body.mode as string] ?? String(body.mode) }
			if (body.mode === "cloud" || body.mode === "claim") {
				if (body.databaseUrl) details["Connection string"] = body.databaseUrl as string
				if (body.sourceId) details["Source ID"] = body.sourceId as string
			}
			if (body.mode === "claim" && body.claimId) {
				details["Claim link"] = getClaimUrl(body.claimId as string)
			}
			if (body.repoAccount && (body.repoName as string)?.trim()) {
				details.Repository = `${body.repoAccount}/${body.repoName}`
				details.Visibility = (body.repoVisibility as string) || "private"
			}
		}

		// Persist gate resolution so replays mark the gate as resolved
		try {
			const bridge = getOrCreateBridge(config, sessionId)
			await bridge.emit({ type: "gate_resolved", gate, summary, details, resolvedBy, ts: ts() })
		} catch {
			// Non-critical
		}

		console.log(`[respond] gate ${gate} resolved successfully`)
		return c.json({ ok: true })
	})

	// Check app status
	app.get("/api/sessions/:id/app-status", async (c) => {
		const sessionId = c.req.param("id")
		const session = config.sessions.get(sessionId)
		if (!session) return c.json({ error: "Session not found" }, 404)

		const handle = config.sandbox.get(sessionId)
		if (!handle || !config.sandbox.isAlive(handle)) {
			return c.json({ running: false, port: session.appPort, previewUrl: session.previewUrl })
		}
		const running = await config.sandbox.isAppRunning(handle)
		return c.json({
			running,
			port: handle.port ?? session.appPort,
			previewUrl: handle.previewUrl ?? session.previewUrl,
		})
	})

	// Start the generated app
	app.post("/api/sessions/:id/start-app", async (c) => {
		const sessionId = c.req.param("id")
		const session = config.sessions.get(sessionId)
		if (!session) return c.json({ error: "Session not found" }, 404)

		const handle = config.sandbox.get(sessionId)
		if (!handle || !config.sandbox.isAlive(handle)) {
			return c.json({ error: "Container is not running" }, 400)
		}
		const ok = await config.sandbox.startApp(handle)
		return c.json({ ok })
	})

	// Stop the generated app
	app.post("/api/sessions/:id/stop-app", async (c) => {
		const sessionId = c.req.param("id")
		const session = config.sessions.get(sessionId)
		if (!session) return c.json({ error: "Session not found" }, 404)

		const handle = config.sandbox.get(sessionId)
		if (handle && config.sandbox.isAlive(handle)) {
			await config.sandbox.stopApp(handle)
		}
		return c.json({ success: true })
	})

	// Interrupt the running Claude Code process without destroying the session.
	// The sandbox stays alive and the bridge remains open for follow-up messages.
	app.post("/api/sessions/:id/interrupt", async (c) => {
		const sessionId = c.req.param("id")

		const bridge = bridges.get(sessionId)
		if (bridge) {
			bridge.interrupt()

			// Emit session_end so the UI knows the process stopped
			await bridge.emit({
				type: "session_end",
				success: false,
				ts: ts(),
			})
		}

		rejectAllGates(sessionId)
		config.sessions.update(sessionId, { status: "complete" })
		return c.json({ ok: true })
	})

	// Cancel a running session
	app.post("/api/sessions/:id/cancel", async (c) => {
		const sessionId = c.req.param("id")

		// Write session_end to the stream so SSE clients see the cancellation
		const conn = sessionStream(config, sessionId)
		try {
			const stream = new DurableStream({
				url: conn.url,
				headers: conn.headers,
				contentType: "application/json",
			})
			const endEvent = {
				source: "server",
				type: "session_end",
				success: false,
				ts: ts(),
			}
			await stream.append(JSON.stringify(endEvent))
		} catch {
			// Best effort — stream may not exist yet
		}

		closeBridge(sessionId)

		const handle = config.sandbox.get(sessionId)
		if (handle) await config.sandbox.destroy(handle)

		rejectAllGates(sessionId)
		config.sessions.update(sessionId, { status: "cancelled" })
		return c.json({ ok: true })
	})

	// Delete a session
	app.delete("/api/sessions/:id", async (c) => {
		const sessionId = c.req.param("id")

		closeBridge(sessionId)

		const handle = config.sandbox.get(sessionId)
		if (handle) await config.sandbox.destroy(handle)

		rejectAllGates(sessionId)

		const deleted = config.sessions.delete(sessionId)
		if (!deleted) return c.json({ error: "Session not found" }, 404)
		return c.json({ ok: true })
	})

	// --- Sandbox CRUD Routes ---

	// List all active sandboxes
	app.get("/api/sandboxes", (c) => {
		const sandboxes = config.sandbox.list().map((h) => ({
			sessionId: h.sessionId,
			runtime: h.runtime,
			port: h.port,
			projectDir: h.projectDir,
			previewUrl: h.previewUrl,
			alive: config.sandbox.isAlive(h),
		}))
		return c.json({ sandboxes })
	})

	// Get a specific sandbox's status
	app.get("/api/sandboxes/:sessionId", async (c) => {
		const sessionId = c.req.param("sessionId")
		const handle = config.sandbox.get(sessionId)
		if (!handle) return c.json({ error: "Sandbox not found" }, 404)

		const alive = config.sandbox.isAlive(handle)
		const appRunning = alive ? await config.sandbox.isAppRunning(handle) : false

		return c.json({
			sessionId: handle.sessionId,
			runtime: handle.runtime,
			port: handle.port,
			projectDir: handle.projectDir,
			previewUrl: handle.previewUrl,
			alive,
			appRunning,
		})
	})

	// Create a standalone sandbox (not tied to session creation flow)
	app.post("/api/sandboxes", async (c) => {
		const body = (await c.req.json()) as {
			sessionId?: string
			projectName?: string
			infra?: InfraConfig
		}

		const sessionId = body.sessionId ?? crypto.randomUUID()
		try {
			const handle = await config.sandbox.create(sessionId, {
				projectName: body.projectName,
				infra: body.infra,
			})
			return c.json(
				{
					sessionId: handle.sessionId,
					runtime: handle.runtime,
					port: handle.port,
					projectDir: handle.projectDir,
					previewUrl: handle.previewUrl,
				},
				201,
			)
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Failed to create sandbox"
			return c.json({ error: msg }, 500)
		}
	})

	// Delete a sandbox
	app.delete("/api/sandboxes/:sessionId", async (c) => {
		const sessionId = c.req.param("sessionId")
		const handle = config.sandbox.get(sessionId)
		if (!handle) return c.json({ error: "Sandbox not found" }, 404)

		closeBridge(sessionId)
		await config.sandbox.destroy(handle)
		return c.json({ ok: true })
	})

	// --- Shared Sessions ---

	// Protect /api/shared-sessions/:id/* (all sub-routes)
	// Exempt: "join" (Hono matches join/:code as :id/*)
	const sharedSessionExemptIds = new Set(["join"])

	app.use("/api/shared-sessions/:id/*", async (c, next) => {
		const id = c.req.param("id")
		if (sharedSessionExemptIds.has(id)) return next()

		const token = extractToken(c)
		if (!token || !validateSessionToken(config.streamConfig.secret, id, token)) {
			return c.json({ error: "Invalid or missing room token" }, 401)
		}
		return next()
	})

	// Create a shared session
	app.post("/api/shared-sessions", async (c) => {
		const body = (await c.req.json()) as {
			name: string
			participant: Participant
		}
		if (!body.name || !body.participant?.id || !body.participant?.displayName) {
			return c.json({ error: "name and participant (id, displayName) are required" }, 400)
		}

		const id = crypto.randomUUID()
		const code = generateInviteCode()

		// Create the shared session durable stream
		const conn = sharedSessionStream(config, id)
		try {
			await DurableStream.create({
				url: conn.url,
				headers: conn.headers,
				contentType: "application/json",
			})
		} catch (err) {
			console.error(`[shared-session] Failed to create durable stream:`, err)
			return c.json({ error: "Failed to create shared session stream" }, 500)
		}

		// Write shared_session_created event
		const stream = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})
		const createdEvent: SharedSessionEvent = {
			type: "shared_session_created",
			name: body.name,
			code,
			createdBy: body.participant,
			ts: ts(),
		}
		await stream.append(JSON.stringify(createdEvent))

		// Write participant_joined for the creator
		const joinedEvent: SharedSessionEvent = {
			type: "participant_joined",
			participant: body.participant,
			ts: ts(),
		}
		await stream.append(JSON.stringify(joinedEvent))

		// Save to room registry
		await config.rooms.addRoom({
			id,
			code,
			name: body.name,
			createdAt: new Date().toISOString(),
			revoked: false,
		})

		const roomToken = deriveSessionToken(config.streamConfig.secret, id)
		console.log(`[shared-session] Created: id=${id} code=${code}`)
		return c.json({ id, code, roomToken }, 201)
	})

	// Resolve invite (id + code) → shared session ID + room token
	app.get("/api/shared-sessions/join/:id/:code", (c) => {
		const id = c.req.param("id")
		const code = c.req.param("code")
		const entry = config.rooms.getRoom(id)
		if (!entry || entry.code !== code) return c.json({ error: "Shared session not found" }, 404)
		const roomToken = deriveSessionToken(config.streamConfig.secret, entry.id)
		return c.json({ id: entry.id, code: entry.code, revoked: entry.revoked, roomToken })
	})

	// Join a shared session as participant
	app.post("/api/shared-sessions/:id/join", async (c) => {
		const id = c.req.param("id")
		const entry = config.rooms.getRoom(id)
		if (!entry) return c.json({ error: "Shared session not found" }, 404)
		if (entry.revoked) return c.json({ error: "Invite code has been revoked" }, 403)

		const body = (await c.req.json()) as { participant: Participant }
		if (!body.participant?.id || !body.participant?.displayName) {
			return c.json({ error: "participant (id, displayName) is required" }, 400)
		}

		const conn = sharedSessionStream(config, id)
		const stream = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})
		const event: SharedSessionEvent = {
			type: "participant_joined",
			participant: body.participant,
			ts: ts(),
		}
		await stream.append(JSON.stringify(event))

		return c.json({ ok: true })
	})

	// Leave a shared session
	app.post("/api/shared-sessions/:id/leave", async (c) => {
		const id = c.req.param("id")
		const body = (await c.req.json()) as { participantId: string }
		if (!body.participantId) {
			return c.json({ error: "participantId is required" }, 400)
		}

		const conn = sharedSessionStream(config, id)
		const stream = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})
		const event: SharedSessionEvent = {
			type: "participant_left",
			participantId: body.participantId,
			ts: ts(),
		}
		await stream.append(JSON.stringify(event))

		return c.json({ ok: true })
	})

	// Heartbeat ping for room presence (in-memory, not persisted to stream)
	app.post("/api/shared-sessions/:id/ping", async (c) => {
		const id = c.req.param("id")
		const body = (await c.req.json()) as { participantId: string; displayName: string }
		if (!body.participantId) {
			return c.json({ error: "participantId is required" }, 400)
		}

		let room = roomPresence.get(id)
		if (!room) {
			room = new Map()
			roomPresence.set(id, room)
		}
		room.set(body.participantId, {
			displayName: body.displayName || body.participantId.slice(0, 8),
			lastPing: Date.now(),
		})

		return c.json({ ok: true })
	})

	// Get active participants (pinged within last 90 seconds)
	app.get("/api/shared-sessions/:id/presence", (c) => {
		const id = c.req.param("id")
		const room = roomPresence.get(id)
		const STALE_MS = 90_000
		const now = Date.now()
		const active: Participant[] = []

		if (room) {
			for (const [pid, info] of room) {
				if (now - info.lastPing < STALE_MS) {
					active.push({ id: pid, displayName: info.displayName })
				} else {
					room.delete(pid)
				}
			}
		}

		return c.json({ participants: active })
	})

	// Link a session to a shared session (room)
	// The client sends session metadata since sessions are private (localStorage).
	app.post("/api/shared-sessions/:id/sessions", async (c) => {
		const id = c.req.param("id")
		const body = (await c.req.json()) as {
			sessionId: string
			sessionName: string
			sessionDescription: string
			linkedBy: string
		}
		if (!body.sessionId || !body.linkedBy) {
			return c.json({ error: "sessionId and linkedBy are required" }, 400)
		}

		const conn = sharedSessionStream(config, id)
		const stream = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})
		const event: SharedSessionEvent = {
			type: "session_linked",
			sessionId: body.sessionId,
			sessionName: body.sessionName || "",
			sessionDescription: body.sessionDescription || "",
			linkedBy: body.linkedBy,
			ts: ts(),
		}
		await stream.append(JSON.stringify(event))

		return c.json({ ok: true })
	})

	// Get a session token for a linked session (allows room participants to read session streams)
	app.get("/api/shared-sessions/:id/sessions/:sessionId/token", (c) => {
		const sessionId = c.req.param("sessionId")
		const sessionToken = deriveSessionToken(config.streamConfig.secret, sessionId)
		return c.json({ sessionToken })
	})

	// Unlink a session from a shared session
	app.delete("/api/shared-sessions/:id/sessions/:sessionId", async (c) => {
		const id = c.req.param("id")
		const sessionId = c.req.param("sessionId")

		const conn = sharedSessionStream(config, id)
		const stream = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})
		const event: SharedSessionEvent = {
			type: "session_unlinked",
			sessionId,
			ts: ts(),
		}
		await stream.append(JSON.stringify(event))

		return c.json({ ok: true })
	})

	// SSE proxy for shared session events
	app.get("/api/shared-sessions/:id/events", async (c) => {
		const id = c.req.param("id")
		const entry = config.rooms.getRoom(id)
		if (!entry) return c.json({ error: "Shared session not found" }, 404)

		const connection = sharedSessionStream(config, id)
		const lastEventId = c.req.header("Last-Event-ID") || c.req.query("offset") || "-1"

		const reader = new DurableStream({
			url: connection.url,
			headers: connection.headers,
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
				const data = JSON.stringify(item)
				writer.write(encoder.encode(`id:${batch.offset}\ndata:${data}\n\n`)).catch(() => {
					cancelled = true
				})
			}
		})

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

	// Revoke a shared session's invite code
	app.post("/api/shared-sessions/:id/revoke", async (c) => {
		const id = c.req.param("id")
		const revoked = await config.rooms.revokeRoom(id)
		if (!revoked) return c.json({ error: "Shared session not found" }, 404)

		const conn = sharedSessionStream(config, id)
		const stream = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})
		const event: SharedSessionEvent = {
			type: "code_revoked",
			ts: ts(),
		}
		await stream.append(JSON.stringify(event))

		return c.json({ ok: true })
	})

	// --- Room Routes (agent-to-agent messaging) ---

	// Create a room
	app.post("/api/rooms", async (c) => {
		const body = (await c.req.json()) as {
			name: string
			maxRounds?: number
		}
		if (!body.name) {
			return c.json({ error: "name is required" }, 400)
		}

		const roomId = crypto.randomUUID()

		// Create the room's durable stream
		const conn = roomStream(config, roomId)
		try {
			await DurableStream.create({
				url: conn.url,
				headers: conn.headers,
				contentType: "application/json",
			})
		} catch (err) {
			console.error(`[room] Failed to create durable stream:`, err)
			return c.json({ error: "Failed to create room stream" }, 500)
		}

		// Create and start the router
		const router = new RoomRouter(roomId, body.name, config.streamConfig, {
			maxRounds: body.maxRounds,
		})
		await router.start()
		roomRouters.set(roomId, router)

		// Save to room registry for persistence
		const code = generateInviteCode()
		await config.rooms.addRoom({
			id: roomId,
			code,
			name: body.name,
			createdAt: new Date().toISOString(),
			revoked: false,
		})

		const roomToken = deriveSessionToken(config.streamConfig.secret, roomId)
		console.log(`[room] Created: id=${roomId} name=${body.name} code=${code}`)
		return c.json({ roomId, code, roomToken }, 201)
	})

	// Join an agent room by id + invite code
	app.get("/api/rooms/join/:id/:code", (c) => {
		const id = c.req.param("id")
		const code = c.req.param("code")
		const room = config.rooms.getRoom(id)
		if (!room || room.code !== code) return c.json({ error: "Room not found" }, 404)
		if (room.revoked) return c.json({ error: "Room has been revoked" }, 410)

		const roomToken = deriveSessionToken(config.streamConfig.secret, room.id)
		return c.json({ id: room.id, code: room.code, name: room.name, roomToken })
	})

	// Get room state
	app.get("/api/rooms/:id", (c) => {
		const roomId = c.req.param("id")
		const router = roomRouters.get(roomId)
		if (!router) return c.json({ error: "Room not found" }, 404)

		return c.json({
			roomId,
			state: router.state,
			roundCount: router.roundCount,
			participants: router.participants.map((p) => ({
				sessionId: p.sessionId,
				name: p.name,
				role: p.role,
				running: p.bridge.isRunning(),
			})),
		})
	})

	// Add an agent to a room
	app.post("/api/rooms/:id/agents", async (c) => {
		const roomId = c.req.param("id")
		const router = roomRouters.get(roomId)
		if (!router) return c.json({ error: "Room not found" }, 404)

		const body = (await c.req.json()) as {
			name: string
			role?: string
			gated?: boolean
			initialPrompt?: string
			apiKey?: string
			oauthToken?: string
			ghToken?: string
		}
		if (!body.name) {
			return c.json({ error: "name is required" }, 400)
		}

		const sessionId = crypto.randomUUID()
		const projectName = `room-${body.name}-${sessionId.slice(0, 8)}`

		console.log(`[room:${roomId}] Adding agent: name=${body.name} session=${sessionId}`)

		// Create the session's durable stream
		const conn = sessionStream(config, sessionId)
		try {
			await DurableStream.create({
				url: conn.url,
				headers: conn.headers,
				contentType: "application/json",
			})
		} catch (err) {
			console.error(`[room:${roomId}] Failed to create session stream:`, err)
			return c.json({ error: "Failed to create session stream" }, 500)
		}

		// Create bridge
		const bridge = getOrCreateBridge(config, sessionId)

		// Record session
		const sandboxProjectDir = `/home/agent/workspace/${projectName}`
		const session: SessionInfo = {
			id: sessionId,
			projectName,
			sandboxProjectDir,
			description: `Room agent: ${body.name} (${body.role ?? "participant"})`,
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: "running",
		}
		config.sessions.add(session)

		// Return early so the client can store the session token and show the
		// session in the sidebar immediately. The sandbox setup continues in
		// the background — events stream to the session's durable stream so
		// the UI stays up to date.
		const sessionToken = deriveSessionToken(config.streamConfig.secret, sessionId)

		// Kick off sandbox creation + agent startup in the background
		;(async () => {
			await bridge.emit({
				type: "log",
				level: "build",
				message: `Creating sandbox for room agent "${body.name}"...`,
				ts: ts(),
			})

			try {
				const handle = await config.sandbox.create(sessionId, {
					projectName,
					infra: { mode: "local" },
					apiKey: body.apiKey,
					oauthToken: body.oauthToken,
					ghToken: body.ghToken,
				})

				config.sessions.update(sessionId, {
					appPort: handle.port,
					sandboxProjectDir: handle.projectDir,
					previewUrl: handle.previewUrl,
				})

				// Inject room-messaging skill so agents know the @room protocol
				if (roomMessagingSkillContent) {
					try {
						const skillDir = `${handle.projectDir}/.claude/skills/room-messaging`
						const skillB64 = Buffer.from(roomMessagingSkillContent).toString("base64")
						await config.sandbox.exec(
							handle,
							`mkdir -p '${skillDir}' && echo '${skillB64}' | base64 -d > '${skillDir}/SKILL.md'`,
						)
						// Append room-messaging reference to CLAUDE.md so the agent knows to read it
						const roomRef = `\n\n## Room Messaging (CRITICAL)\nYou are a participant in a multi-agent room. Read .claude/skills/room-messaging/SKILL.md for the messaging protocol.\nAll communication with other agents MUST use @room or @<name> messages as described in that skill.\n`
						const refB64 = Buffer.from(roomRef).toString("base64")
						await config.sandbox.exec(
							handle,
							`echo '${refB64}' | base64 -d >> '${handle.projectDir}/CLAUDE.md'`,
						)
					} catch (err) {
						console.error(`[session:${sessionId}] Failed to write room-messaging skill:`, err)
					}
				}

				// Resolve role skill (behavioral guidelines + tool permissions)
				const roleSkill = resolveRoleSkill(body.role)

				// Inject role skill file into sandbox
				if (roleSkill) {
					try {
						const skillDir = `${handle.projectDir}/.claude/skills/role`
						const skillB64 = Buffer.from(roleSkill.skillContent).toString("base64")
						await config.sandbox.exec(
							handle,
							`mkdir -p '${skillDir}' && echo '${skillB64}' | base64 -d > '${skillDir}/SKILL.md'`,
						)
					} catch (err) {
						console.error(`[session:${sessionId}] Failed to write role skill:`, err)
					}
				}

				// Build prompt — reference the role skill if available
				const rolePromptSuffix = roleSkill
					? `\nRead .claude/skills/role/SKILL.md for your role guidelines before proceeding.`
					: ""
				const agentPrompt = `You are "${body.name}"${body.role ? `, role: ${body.role}` : ""}. You are joining a multi-agent room.${rolePromptSuffix}`

				// Create Claude Code bridge (with role-specific tool permissions)
				const agentHookToken = deriveHookToken(config.streamConfig.secret, sessionId)
				const claudeConfig: ClaudeCodeDockerConfig | ClaudeCodeSpritesConfig =
					config.sandbox.runtime === "sprites"
						? {
								prompt: agentPrompt,
								cwd: handle.projectDir,
								studioUrl: resolveStudioUrl(config.port),
								hookToken: agentHookToken,
								agentName: body.name,
								...(roleSkill?.allowedTools && { allowedTools: roleSkill.allowedTools }),
							}
						: {
								prompt: agentPrompt,
								cwd: handle.projectDir,
								studioPort: config.port,
								hookToken: agentHookToken,
								agentName: body.name,
								...(roleSkill?.allowedTools && { allowedTools: roleSkill.allowedTools }),
							}
				const ccBridge = createClaudeCodeBridge(config, sessionId, claudeConfig)

				// Track Claude Code session ID and cost
				ccBridge.onAgentEvent((event) => {
					if (event.type === "session_start") {
						const ccSessionId = (event as EngineEvent & { session_id?: string }).session_id
						if (ccSessionId) {
							config.sessions.update(sessionId, { lastCoderSessionId: ccSessionId })
						}
					}
					if (event.type === "session_end") {
						accumulateSessionCost(config, sessionId, event)
					}
					// Route assistant_message output to the room router
					if (event.type === "assistant_message" && "text" in event) {
						router
							.handleAgentOutput(sessionId, (event as EngineEvent & { text: string }).text)
							.catch((err) => {
								console.error(`[room:${roomId}] handleAgentOutput error:`, err)
							})
					}
				})

				await bridge.emit({
					type: "log",
					level: "done",
					message: `Sandbox ready for "${body.name}"`,
					ts: ts(),
				})

				await ccBridge.start()

				// Add participant to room router
				const participant: RoomParticipant = {
					sessionId,
					name: body.name,
					role: body.role,
					bridge: ccBridge,
				}
				await router.addParticipant(participant, body.gated ?? false)

				// If there's an initial prompt, send it directly to this agent only (not broadcast)
				if (body.initialPrompt) {
					await ccBridge.sendCommand({ command: "iterate", request: body.initialPrompt })
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Failed to create agent sandbox"
				console.error(`[room:${roomId}] Agent creation failed:`, err)
				await bridge.emit({ type: "log", level: "error", message: msg, ts: ts() })
			}
		})()

		return c.json({ sessionId, participantName: body.name, sessionToken }, 201)
	})

	// Add an existing running session to a room
	app.post("/api/rooms/:id/sessions", async (c) => {
		const roomId = c.req.param("id")
		const router = roomRouters.get(roomId)
		if (!router) return c.json({ error: "Room not found" }, 404)

		const body = (await c.req.json()) as {
			sessionId: string
			name: string
			initialPrompt?: string
		}
		if (!body.sessionId || !body.name) {
			return c.json({ error: "sessionId and name are required" }, 400)
		}

		const { sessionId } = body

		// Require a valid session token — caller must already own this session
		const authHeader = c.req.header("Authorization")
		const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined
		if (!token || !validateSessionToken(config.streamConfig.secret, sessionId, token)) {
			return c.json({ error: "Invalid or missing session token" }, 401)
		}

		// Verify the session exists
		const sessionInfo = config.sessions.get(sessionId)
		if (!sessionInfo) {
			return c.json({ error: "Session not found" }, 404)
		}

		// Get the sandbox handle — must be running
		const handle = config.sandbox.get(sessionId)
		if (!handle) {
			return c.json({ error: "Session sandbox not found or not running" }, 400)
		}

		// Get or create bridge (it should already exist for a running session)
		const bridge = getOrCreateBridge(config, sessionId)

		console.log(`[room:${roomId}] Adding existing session: name=${body.name} session=${sessionId}`)

		try {
			// Inject room-messaging skill
			if (roomMessagingSkillContent) {
				try {
					const skillDir = `${handle.projectDir}/.claude/skills/room-messaging`
					const skillB64 = Buffer.from(roomMessagingSkillContent).toString("base64")
					await config.sandbox.exec(
						handle,
						`mkdir -p '${skillDir}' && echo '${skillB64}' | base64 -d > '${skillDir}/SKILL.md'`,
					)
					// Append room-messaging reference to CLAUDE.md so the agent knows to read it
					const roomRef = `\n\n## Room Messaging (CRITICAL)\nYou are a participant in a multi-agent room. Read .claude/skills/room-messaging/SKILL.md for the messaging protocol.\nAll communication with other agents MUST use @room or @<name> messages as described in that skill.\n`
					const refB64 = Buffer.from(roomRef).toString("base64")
					await config.sandbox.exec(
						handle,
						`echo '${refB64}' | base64 -d >> '${handle.projectDir}/CLAUDE.md'`,
					)
				} catch (err) {
					console.error(`[session:${sessionId}] Failed to write room-messaging skill:`, err)
				}
			}

			// The existing bridge is already a Claude Code bridge — wire up room output handling
			bridge.onAgentEvent((event) => {
				if (event.type === "assistant_message" && "text" in event) {
					router
						.handleAgentOutput(sessionId, (event as EngineEvent & { text: string }).text)
						.catch((err) => {
							console.error(`[room:${roomId}] handleAgentOutput error:`, err)
						})
				}
			})

			// Add participant to room router
			const participant: RoomParticipant = {
				sessionId,
				name: body.name,
				bridge,
			}
			await router.addParticipant(participant, false)

			// If there's an initial prompt, send it directly to this agent
			if (body.initialPrompt) {
				await bridge.sendCommand({ command: "iterate", request: body.initialPrompt })
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Failed to add session to room"
			console.error(`[room:${roomId}] Add session failed:`, err)
			return c.json({ error: msg }, 500)
		}

		// No need to return sessionToken — caller already proved they have it
		return c.json({ sessionId, participantName: body.name }, 201)
	})

	// Send a message directly to a specific session in a room (bypasses room stream)
	app.post("/api/rooms/:id/sessions/:sessionId/iterate", async (c) => {
		const roomId = c.req.param("id")
		const sessionId = c.req.param("sessionId")
		const router = roomRouters.get(roomId)
		if (!router) return c.json({ error: "Room not found" }, 404)

		const participant = router.participants.find((p) => p.sessionId === sessionId)
		if (!participant) return c.json({ error: "Session not found in this room" }, 404)

		const body = (await c.req.json()) as { request: string }
		if (!body.request) {
			return c.json({ error: "request is required" }, 400)
		}

		await participant.bridge.sendCommand({
			command: "iterate",
			request: body.request,
		})
		return c.json({ ok: true })
	})

	// Send a message to a room (from human or API)
	app.post("/api/rooms/:id/messages", async (c) => {
		const roomId = c.req.param("id")
		const router = roomRouters.get(roomId)
		if (!router) return c.json({ error: "Room not found" }, 404)

		const body = (await c.req.json()) as {
			from: string
			body: string
			to?: string
		}
		if (!body.from || !body.body) {
			return c.json({ error: "from and body are required" }, 400)
		}

		await router.sendMessage(body.from, body.body, body.to)
		return c.json({ ok: true })
	})

	// SSE proxy for room events
	app.get("/api/rooms/:id/events", async (c) => {
		const roomId = c.req.param("id")
		const router = roomRouters.get(roomId)
		if (!router) return c.json({ error: "Room not found" }, 404)

		const connection = roomStream(config, roomId)
		const lastEventId = c.req.header("Last-Event-ID") || c.req.query("offset") || "-1"

		const reader = new DurableStream({
			url: connection.url,
			headers: connection.headers,
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
				const data = JSON.stringify(item)
				writer.write(encoder.encode(`id:${batch.offset}\ndata:${data}\n\n`)).catch(() => {
					cancelled = true
				})
			}
		})

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

	// Close a room
	app.post("/api/rooms/:id/close", async (c) => {
		const roomId = c.req.param("id")
		const router = roomRouters.get(roomId)
		if (!router) return c.json({ error: "Room not found" }, 404)

		// Emit room_closed event
		const conn = roomStream(config, roomId)
		const stream = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})
		const event: SharedSessionEvent = {
			type: "room_closed",
			closedBy: "human",
			summary: "Room closed by user",
			ts: ts(),
		}
		await stream.append(JSON.stringify(event))
		router.close()

		return c.json({ ok: true })
	})

	// --- SSE Proxy ---

	// Server-side SSE proxy: reads from the hosted durable stream and proxies
	// events to the React client. The client never sees DS credentials.
	app.get("/api/sessions/:id/events", async (c) => {
		const sessionId = c.req.param("id")
		console.log(`[sse] Client connected: session=${sessionId}`)

		// Get the stream connection info (no session lookup needed —
		// the DS stream may exist from a previous server lifetime)
		const connection = sessionStream(config, sessionId)

		// Last-Event-ID allows reconnection from where the client left off.
		// Also check for an explicit ?offset= query param — when the client
		// manually reconnects (e.g. after a tab switch), the new EventSource
		// won't carry the Last-Event-ID from the previous connection, so the
		// client passes it explicitly.
		const lastEventId = c.req.header("Last-Event-ID") || c.req.query("offset") || "-1"
		console.log(`[sse] Reading stream from offset=${lastEventId} url=${connection.url}`)

		const reader = new DurableStream({
			url: connection.url,
			headers: connection.headers,
			contentType: "application/json",
		})

		const { readable, writable } = new TransformStream()
		const writer = writable.getWriter()
		const encoder = new TextEncoder()

		let cancelled = false
		let eventCount = 0

		const response = await reader.stream<Record<string, unknown>>({
			offset: lastEventId,
			live: true,
		})

		const cancel = response.subscribeJson<Record<string, unknown>>((batch) => {
			if (cancelled) return
			for (const item of batch.items) {
				// Skip internal protocol messages (commands sent to agent, gate responses)
				// but allow server-emitted EngineEvents (like infra_config_prompt) through
				const msgType = item.type as string | undefined
				if (msgType === "command" || msgType === "gate_response") {
					console.log(
						`[sse] Filtered protocol message: type=${msgType} source=${item.source} session=${sessionId}`,
					)
					continue
				}

				eventCount++
				console.log(
					`[sse] Proxying event #${eventCount}: type=${msgType} source=${item.source} session=${sessionId}`,
				)

				// Strip the source field before sending to client
				const { source: _, ...eventData } = item
				const data = JSON.stringify(eventData)
				writer.write(encoder.encode(`id:${batch.offset}\ndata:${data}\n\n`)).catch(() => {
					cancelled = true
				})
			}
		})

		// Clean up when client disconnects
		c.req.raw.signal.addEventListener("abort", () => {
			console.log(`[sse] Client disconnected: session=${sessionId} (sent ${eventCount} events)`)
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

	// --- Git/GitHub Routes ---

	// Get git status for a session
	app.get("/api/sessions/:id/git-status", async (c) => {
		const sessionId = c.req.param("id")
		const session = config.sessions.get(sessionId)
		if (!session) return c.json({ error: "Session not found" }, 404)

		const handle = config.sandbox.get(sessionId)
		if (!handle) {
			return c.json({ error: "Container not available" }, 404)
		}
		try {
			const status = await config.sandbox.gitStatus(
				handle,
				session.sandboxProjectDir || handle.projectDir,
			)
			return c.json(status)
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : "Failed to get git status" }, 500)
		}
	})

	// List all files in the project directory
	app.get("/api/sessions/:id/files", async (c) => {
		const sessionId = c.req.param("id")
		const session = config.sessions.get(sessionId)
		if (!session) return c.json({ error: "Session not found" }, 404)

		const handle = config.sandbox.get(sessionId)
		const sandboxDir = session.sandboxProjectDir
		if (!handle || !sandboxDir) {
			return c.json({ files: [], prefix: sandboxDir ?? "" })
		}
		const files = await config.sandbox.listFiles(handle, sandboxDir)
		return c.json({ files, prefix: sandboxDir })
	})

	// Read a file's content
	app.get("/api/sessions/:id/file-content", async (c) => {
		const sessionId = c.req.param("id")
		const session = config.sessions.get(sessionId)
		if (!session) return c.json({ error: "Session not found" }, 404)

		const filePath = c.req.query("path")
		if (!filePath) return c.json({ error: "path query parameter required" }, 400)

		const handle = config.sandbox.get(sessionId)
		const sandboxDir = session.sandboxProjectDir
		if (!handle || !sandboxDir) {
			return c.json({ error: "Container not available" }, 404)
		}
		if (!filePath.startsWith(sandboxDir)) {
			return c.json({ error: "Path outside project directory" }, 403)
		}
		const content = await config.sandbox.readFile(handle, filePath)
		if (content === null) {
			return c.json({ error: "File not found or unreadable" }, 404)
		}
		return c.json({ content })
	})

	// List GitHub accounts (personal + orgs) — requires client-provided token
	app.get("/api/github/accounts", (c) => {
		const token = c.req.header("X-GH-Token")
		if (!token) return c.json({ accounts: [] })
		try {
			const accounts = ghListAccounts(token)
			return c.json({ accounts })
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : "Failed to list accounts" }, 500)
		}
	})

	// List GitHub repos for the authenticated user — requires client-provided token
	app.get("/api/github/repos", (c) => {
		const token = c.req.header("X-GH-Token")
		if (!token) return c.json({ repos: [] })
		try {
			const repos = ghListRepos(50, token)
			return c.json({ repos })
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : "Failed to list repos" }, 500)
		}
	})

	app.get("/api/github/repos/:owner/:repo/branches", (c) => {
		const owner = c.req.param("owner")
		const repo = c.req.param("repo")
		const token = c.req.header("X-GH-Token")
		if (!token) return c.json({ branches: [] })
		try {
			const branches = ghListBranches(`${owner}/${repo}`, token)
			return c.json({ branches })
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : "Failed to list branches" }, 500)
		}
	})

	// Read Claude credentials from macOS Keychain (dev convenience)
	app.get("/api/credentials/keychain", (c) => {
		if (process.platform !== "darwin") {
			return c.json({ apiKey: null })
		}
		try {
			const raw = execFileSync(
				"security",
				["find-generic-password", "-s", "Claude Code-credentials", "-w"],
				{ encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
			).trim()
			const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } }
			const token = parsed.claudeAiOauth?.accessToken ?? null
			if (token) {
				console.log(
					`[dev] Loaded OAuth token from keychain: ${token.slice(0, 20)}...${token.slice(-10)}`,
				)
			} else {
				console.log("[dev] No OAuth token found in keychain")
			}
			return c.json({ oauthToken: token })
		} catch {
			return c.json({ oauthToken: null })
		}
	})

	// Resume a project from a GitHub repo
	app.post("/api/sessions/resume", async (c) => {
		const body = (await c.req.json()) as {
			repoUrl: string
			branch?: string
			apiKey?: string
			oauthToken?: string
			ghToken?: string
		}
		if (!body.repoUrl) {
			return c.json({ error: "repoUrl is required" }, 400)
		}

		const sessionId = crypto.randomUUID()
		const repoName =
			body.repoUrl
				.split("/")
				.pop()
				?.replace(/\.git$/, "") || "resumed-project"

		// Create durable stream
		const conn = sessionStream(config, sessionId)
		try {
			await DurableStream.create({
				url: conn.url,
				headers: conn.headers,
				contentType: "application/json",
			})
		} catch {
			return c.json({ error: "Failed to create event stream" }, 500)
		}

		// Create the initial session bridge for emitting progress events
		const bridge = getOrCreateBridge(config, sessionId)

		// Record session as running (like normal session creation)
		const sandboxProjectDir = `/home/agent/workspace/${repoName}`
		const session: SessionInfo = {
			id: sessionId,
			projectName: body.branch ? `${repoName}/${body.branch}` : repoName,
			sandboxProjectDir,
			description: `Resumed from ${body.repoUrl}`,
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: "running",
		}
		config.sessions.add(session)

		// Write user prompt to the stream so it shows in the UI
		await bridge.emit({
			type: "user_prompt",
			message: `Resume from ${body.repoUrl}`,
			ts: ts(),
		})

		// Launch async flow: clone repo → set up Claude Code → start exploring
		const asyncFlow = async () => {
			// 1. Clone the repo into a sandbox
			await bridge.emit({
				type: "log",
				level: "build",
				message: "Cloning repository...",
				ts: ts(),
			})

			const handle = await config.sandbox.createFromRepo(sessionId, body.repoUrl, {
				branch: body.branch,
				apiKey: body.apiKey,
				oauthToken: body.oauthToken,
				ghToken: body.ghToken,
			})

			// Get git state from cloned repo
			const gs = await config.sandbox.gitStatus(handle, handle.projectDir)

			config.sessions.update(sessionId, {
				appPort: handle.port,
				sandboxProjectDir: handle.projectDir,
				previewUrl: handle.previewUrl,
				git: {
					branch: gs.branch ?? body.branch ?? "main",
					remoteUrl: body.repoUrl,
					repoName: parseRepoNameFromUrl(body.repoUrl),
					lastCommitHash: gs.lastCommitHash ?? null,
					lastCommitMessage: gs.lastCommitMessage ?? null,
					lastCheckpointAt: null,
				},
			})

			await bridge.emit({
				type: "log",
				level: "done",
				message: "Repository cloned",
				ts: ts(),
			})

			// 2. Write CLAUDE.md to the sandbox workspace
			const claudeMd = generateClaudeMd({
				description: `Resumed from ${body.repoUrl}`,
				projectName: repoName,
				projectDir: handle.projectDir,
				runtime: config.sandbox.runtime,
				git: {
					mode: "existing",
					repoName: parseRepoNameFromUrl(body.repoUrl) ?? repoName,
					branch: gs.branch ?? body.branch ?? "main",
				},
			})
			try {
				await config.sandbox.exec(
					handle,
					`cat > '${handle.projectDir}/CLAUDE.md' << 'CLAUDEMD_EOF'\n${claudeMd}\nCLAUDEMD_EOF`,
				)
			} catch (err) {
				console.error(`[session:${sessionId}] Failed to write CLAUDE.md:`, err)
			}

			// Ensure the create-app skill is present in the project
			if (createAppSkillContent) {
				try {
					const skillDir = `${handle.projectDir}/.claude/skills/create-app`
					const skillB64 = Buffer.from(createAppSkillContent).toString("base64")
					await config.sandbox.exec(
						handle,
						`mkdir -p '${skillDir}' && echo '${skillB64}' | base64 -d > '${skillDir}/SKILL.md'`,
					)
				} catch (err) {
					console.error(`[session:${sessionId}] Failed to write create-app skill:`, err)
				}
			}

			// Ensure the room-messaging skill is present so agents have
			// persistent access to the multi-agent protocol reference.
			if (roomMessagingSkillContent) {
				try {
					const skillDir = `${handle.projectDir}/.claude/skills/room-messaging`
					const skillB64 = Buffer.from(roomMessagingSkillContent).toString("base64")
					await config.sandbox.exec(
						handle,
						`mkdir -p '${skillDir}' && echo '${skillB64}' | base64 -d > '${skillDir}/SKILL.md'`,
					)
				} catch (err) {
					console.error(`[session:${sessionId}] Failed to write room-messaging skill:`, err)
				}
			}

			// 3. Create Claude Code bridge with a resume prompt
			const resumePrompt =
				"You are resuming work on an existing project. Explore the codebase to understand its structure, then wait for instructions from the user."

			const resumeHookToken = deriveHookToken(config.streamConfig.secret, sessionId)
			const claudeConfig: ClaudeCodeDockerConfig | ClaudeCodeSpritesConfig =
				config.sandbox.runtime === "sprites"
					? {
							prompt: resumePrompt,
							cwd: handle.projectDir,
							studioUrl: resolveStudioUrl(config.port),
							hookToken: resumeHookToken,
						}
					: {
							prompt: resumePrompt,
							cwd: handle.projectDir,
							studioPort: config.port,
							hookToken: resumeHookToken,
						}
			const ccBridge = createClaudeCodeBridge(config, sessionId, claudeConfig)

			// 4. Register event listeners (reuse pattern from normal flow)
			ccBridge.onAgentEvent((event) => {
				if (event.type === "session_start") {
					const ccSessionId = (event as EngineEvent & { session_id?: string }).session_id
					console.log(`[session:${sessionId}] Captured Claude Code session ID: ${ccSessionId}`)
					if (ccSessionId) {
						config.sessions.update(sessionId, { lastCoderSessionId: ccSessionId })
					}
				}
				if (event.type === "session_end") {
					accumulateSessionCost(config, sessionId, event)
				}
			})

			ccBridge.onComplete(async (success) => {
				const updates: Partial<SessionInfo> = {
					status: success ? "complete" : "error",
				}
				try {
					const latestGs = await config.sandbox.gitStatus(handle, handle.projectDir)
					if (latestGs.initialized) {
						const existing = config.sessions.get(sessionId)
						updates.git = {
							branch: latestGs.branch ?? "main",
							remoteUrl: existing?.git?.remoteUrl ?? null,
							repoName: existing?.git?.repoName ?? null,
							repoVisibility: existing?.git?.repoVisibility,
							lastCommitHash: latestGs.lastCommitHash ?? null,
							lastCommitMessage: latestGs.lastCommitMessage ?? null,
							lastCheckpointAt: existing?.git?.lastCheckpointAt ?? null,
						}
					}
				} catch {
					// Container may already be stopped
				}
				config.sessions.update(sessionId, updates)

				// Check if the app is running after completion
				if (success) {
					try {
						const appRunning = await config.sandbox.isAppRunning(handle)
						if (appRunning) {
							await ccBridge.emit({
								type: "app_status",
								status: "running",
								port: handle.port ?? session.appPort,
								previewUrl: handle.previewUrl ?? session.previewUrl,
								ts: ts(),
							})
						}
					} catch {
						// Container may already be stopped
					}
				}
			})

			// 5. Start the bridge and send command
			await ccBridge.emit({
				type: "log",
				level: "build",
				message: "Starting Claude Code...",
				ts: ts(),
			})

			console.log(`[session:${sessionId}] Starting bridge listener...`)
			await ccBridge.start()
			console.log(`[session:${sessionId}] Bridge started, sending 'new' command...`)

			const newCmd: Record<string, unknown> = {
				command: "new",
				description: resumePrompt,
				projectName: repoName,
				baseDir: "/home/agent/workspace",
			}
			await ccBridge.sendCommand(newCmd)
			console.log(`[session:${sessionId}] Command sent, waiting for agent...`)
		}

		asyncFlow().catch(async (err) => {
			console.error(`[session:${sessionId}] Resume flow failed:`, err)
			config.sessions.update(sessionId, { status: "error" })
			try {
				await bridge.emit({
					type: "log",
					level: "error",
					message: `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
					ts: ts(),
				})
			} catch {
				// Bridge may not be usable if the failure happened early
			}
		})

		const sessionToken = deriveSessionToken(config.streamConfig.secret, sessionId)
		return c.json({ sessionId, session, sessionToken }, 201)
	})

	// Serve static SPA files (if built)
	const clientDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "./client")
	if (fs.existsSync(clientDir)) {
		app.use("/*", serveStatic({ root: clientDir }))
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
	dataDir?: string
	rooms: RoomRegistry
	sandbox: SandboxProvider
	streamConfig: StreamConfig
	bridgeMode?: BridgeMode
}): Promise<void> {
	const config: ServerConfig = {
		port: opts.port ?? 4400,
		dataDir: opts.dataDir ?? path.resolve(process.cwd(), ".electric-agent"),
		sessions: new ActiveSessions(),
		rooms: opts.rooms,
		sandbox: opts.sandbox,
		streamConfig: opts.streamConfig,
		bridgeMode: opts.bridgeMode ?? "claude-code",
	}

	fs.mkdirSync(config.dataDir, { recursive: true })

	const app = createApp(config)

	const hostname = process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"

	serve({
		fetch: app.fetch,
		port: config.port,
		hostname,
	})

	console.log(`Web UI server running at http://${hostname}:${config.port}`)
	console.log(`Streams: ${config.streamConfig.url} (service: ${config.streamConfig.serviceId})`)
}
