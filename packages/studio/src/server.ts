import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { DurableStream } from "@durable-streams/client"
import type { EngineEvent, Participant, RoomEvent } from "@electric-agent/protocol"
import { ts } from "@electric-agent/protocol"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import { ActiveSessions } from "./active-sessions.js"
import {
	addAgentSchema,
	addSessionToRoomSchema,
	createAppRoomSchema,
	createRoomSchema,
	createSandboxSchema,
	createSessionSchema,
	iterateRoomSessionSchema,
	iterateSessionSchema,
	resumeSessionSchema,
	sendRoomMessageSchema,
} from "./api-schemas.js"
import { PRODUCTION_ALLOWED_TOOLS } from "./bridge/claude-code-base.js"
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
import { createOrgRepo, getInstallationToken } from "./github-app.js"
import { generateInviteCode } from "./invite-code.js"
import { resolveProjectDir } from "./project-utils.js"
import type { RoomRegistry } from "./room-registry.js"
import { type RoomParticipant, RoomRouter } from "./room-router.js"
import type { DockerSandboxProvider as DockerSandboxProviderType } from "./sandbox/docker.js"
import type { InfraConfig, SandboxProvider } from "./sandbox/index.js"
import type { SpritesSandboxProvider as SpritesSandboxProviderType } from "./sandbox/sprites.js"
import {
	deriveGlobalHookSecret,
	deriveHookToken,
	deriveRoomToken,
	deriveSessionToken,
	validateGlobalHookSecret,
	validateHookToken,
	validateRoomToken,
	validateSessionToken,
} from "./session-auth.js"
import type { SessionInfo } from "./sessions.js"
import {
	getRoomStreamConnectionInfo,
	getStreamConnectionInfo,
	type StreamConfig,
	type StreamConnectionInfo,
} from "./streams.js"
import { isResponse, validateBody } from "./validate.js"

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
	/**
	 * Enable dev-only endpoints (e.g. macOS Keychain credential reading).
	 * Set via `devMode: true` in startWebServer opts or `STUDIO_DEV_MODE=1` env var.
	 * SECURITY: Never enable in production — the keychain endpoint exposes OAuth tokens.
	 */
	devMode: boolean
}

/** Active session bridges — one per running session */
const bridges = new Map<string, SessionBridge>()

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

// ---------------------------------------------------------------------------
// Rate limiting — in-memory sliding window per IP
// ---------------------------------------------------------------------------

const MAX_SESSIONS_PER_IP_PER_HOUR = Number(process.env.MAX_SESSIONS_PER_IP_PER_HOUR) || 5
const MAX_TOTAL_SESSIONS = Number(process.env.MAX_TOTAL_SESSIONS || 50)
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour
const sessionCreationsByIp = new Map<string, number[]>()

// GitHub App config (prod mode — repo creation in electric-apps org)
const GITHUB_APP_ID = process.env.GITHUB_APP_ID
const GITHUB_INSTALLATION_ID = process.env.GITHUB_INSTALLATION_ID
const GITHUB_PRIVATE_KEY = process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, "\n")
const GITHUB_ORG = "electric-apps"

// Rate limiting for GitHub token endpoint
const githubTokenRequestsBySession = new Map<string, number[]>()
const MAX_GITHUB_TOKENS_PER_SESSION_PER_HOUR = 10

function extractClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
	return (
		c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
		c.req.header("cf-connecting-ip") ||
		"unknown"
	)
}

function checkSessionRateLimit(ip: string): boolean {
	const now = Date.now()
	const cutoff = now - RATE_LIMIT_WINDOW_MS
	let timestamps = sessionCreationsByIp.get(ip) ?? []
	// Prune stale entries
	timestamps = timestamps.filter((t) => t > cutoff)
	if (timestamps.length >= MAX_SESSIONS_PER_IP_PER_HOUR) {
		sessionCreationsByIp.set(ip, timestamps)
		return false
	}
	timestamps.push(now)
	sessionCreationsByIp.set(ip, timestamps)
	return true
}

function checkGlobalSessionCap(sessions: ActiveSessions): boolean {
	return sessions.size() >= MAX_TOTAL_SESSIONS
}

function checkGithubTokenRateLimit(sessionId: string): boolean {
	const now = Date.now()
	const requests = githubTokenRequestsBySession.get(sessionId) ?? []
	const recent = requests.filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
	if (recent.length >= MAX_GITHUB_TOKENS_PER_SESSION_PER_HOUR) {
		return false
	}
	recent.push(now)
	githubTokenRequestsBySession.set(sessionId, recent)
	return true
}

// ---------------------------------------------------------------------------
// Per-session cost budget
// ---------------------------------------------------------------------------

const MAX_SESSION_COST_USD = Number(process.env.MAX_SESSION_COST_USD) || 5

/**
 * Accumulate cost and turn metrics from a session_end event into the session's totals.
 * Called each time a Claude Code run finishes (initial + iterate runs).
 * In production mode, enforces a per-session cost budget.
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

	// Enforce budget in production mode
	if (
		!config.devMode &&
		updates.totalCostUsd != null &&
		updates.totalCostUsd > MAX_SESSION_COST_USD
	) {
		console.log(
			`[session:${sessionId}] Budget exceeded: $${updates.totalCostUsd.toFixed(2)} > $${MAX_SESSION_COST_USD}`,
		)
		const bridge = bridges.get(sessionId)
		if (bridge) {
			bridge
				.emit({
					type: "budget_exceeded",
					budget_usd: MAX_SESSION_COST_USD,
					spent_usd: updates.totalCostUsd,
					ts: ts(),
				})
				.catch(() => {})
		}
		config.sessions.update(sessionId, { status: "error" })
		closeBridge(sessionId)
	}
}

/**
 * Create a Claude Code bridge for a session.
 * Spawns `claude` CLI with stream-json I/O inside the sandbox.
 * In production mode, enforces tool restrictions and hardcodes the model.
 */
function createClaudeCodeBridge(
	config: ServerConfig,
	sessionId: string,
	claudeConfig: ClaudeCodeDockerConfig | ClaudeCodeSpritesConfig,
): SessionBridge {
	// Production mode: restrict tools and hardcode model
	if (!config.devMode) {
		if (!claudeConfig.allowedTools) {
			claudeConfig.allowedTools = PRODUCTION_ALLOWED_TOOLS
		}
		claudeConfig.model = undefined // force default (claude-sonnet-4-6)
	}

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

	// Public config — exposes non-sensitive flags to the client
	app.get("/api/config", (c) => {
		return c.json({
			devMode: config.devMode,
			maxSessionCostUsd: config.devMode ? undefined : MAX_SESSION_COST_USD,
		})
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

	// Protect the unified hook endpoint with a global hook secret derived from
	// the DS secret. The hook setup script embeds this secret in the forwarder
	// so that only local Claude Code instances can post events.
	app.use("/api/hook", async (c, next) => {
		const token = extractToken(c)
		if (!token || !validateGlobalHookSecret(config.streamConfig.secret, token)) {
			return c.json({ error: "Invalid or missing hook secret" }, 401)
		}
		return next()
	})

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
		const hookSecret = deriveGlobalHookSecret(config.streamConfig.secret)
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
EA_HOOK_SECRET="\${EA_HOOK_SECRET:-EA_HOOK_SECRET_PLACEHOLDER}"
BODY="$(cat)"

RESPONSE=$(curl -s -X POST "http://localhost:\${EA_PORT}/api/hook" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer \${EA_HOOK_SECRET}" \\
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

# Replace placeholders with actual values
sed -i.bak "s/EA_PORT_PLACEHOLDER/${port}/" "\${FORWARD_SH}" && rm -f "\${FORWARD_SH}.bak"
sed -i.bak "s/EA_HOOK_SECRET_PLACEHOLDER/${hookSecret}/" "\${FORWARD_SH}" && rm -f "\${FORWARD_SH}.bak"
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
		const body = await validateBody(c, createSessionSchema)
		if (isResponse(body)) return body

		// In prod mode, use server-side API key; ignore user-provided credentials
		const apiKey = config.devMode ? body.apiKey : process.env.ANTHROPIC_API_KEY
		const oauthToken = config.devMode ? body.oauthToken : undefined
		const ghToken = config.devMode ? body.ghToken : undefined

		// Block freeform sessions in production mode
		if (body.freeform && !config.devMode) {
			return c.json({ error: "Freeform sessions are not available" }, 403)
		}

		// Rate-limit session creation in production mode
		if (!config.devMode) {
			const ip = extractClientIp(c)
			if (!checkSessionRateLimit(ip)) {
				return c.json({ error: "Too many sessions. Please try again later." }, 429)
			}
			if (checkGlobalSessionCap(config.sessions)) {
				return c.json({ error: "Service at capacity, please try again later" }, 503)
			}
		}

		const sessionId = crypto.randomUUID()
		const inferredName = config.devMode
			? body.name ||
				body.description
					.slice(0, 40)
					.replace(/[^a-z0-9]+/gi, "-")
					.replace(/^-|-$/g, "")
					.toLowerCase()
			: `electric-${sessionId.slice(0, 8)}`
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
			// Gather GitHub accounts for the merged setup gate (dev mode only)
			if (config.devMode && ghToken && isGhAuthenticated(ghToken)) {
				try {
					ghAccounts = ghListAccounts(ghToken)
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
				apiKey,
				oauthToken,
				ghToken,
				...(!config.devMode && {
					prodMode: {
						sessionToken: deriveSessionToken(config.streamConfig.secret, sessionId),
						studioUrl: resolveStudioUrl(config.port),
					},
				}),
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
								`cd '${handle.projectDir}' && sed -i 's/"name": "scaffold-base"/"name": "${projectName.replace(/[^a-z0-9_-]/gi, "-")}"/' package.json`,
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

					// In prod mode, create GitHub repo and initialize git in the sandbox
					let prodGitConfig: { mode: "pre-created"; repoName: string; repoUrl: string } | undefined
					if (!config.devMode && GITHUB_APP_ID && GITHUB_INSTALLATION_ID && GITHUB_PRIVATE_KEY) {
						try {
							// Repo name matches the project name (already has random slug)
							const repoSlug = projectName

							await bridge.emit({
								type: "log",
								level: "build",
								message: "Creating GitHub repository...",
								ts: ts(),
							})

							const { token } = await getInstallationToken(
								GITHUB_APP_ID,
								GITHUB_INSTALLATION_ID,
								GITHUB_PRIVATE_KEY,
							)
							const repo = await createOrgRepo(GITHUB_ORG, repoSlug, token)

							if (repo) {
								const actualRepoName = `${GITHUB_ORG}/${repo.htmlUrl.split("/").pop()}`
								// Initialize git and set remote in the sandbox
								await config.sandbox.exec(
									handle,
									`cd '${handle.projectDir}' && git init -b main && git remote add origin '${repo.cloneUrl}'`,
								)
								prodGitConfig = {
									mode: "pre-created" as const,
									repoName: actualRepoName,
									repoUrl: repo.htmlUrl,
								}

								config.sessions.update(sessionId, {
									git: {
										branch: "main",
										remoteUrl: repo.htmlUrl,
										repoName: actualRepoName,
										lastCommitHash: null,
										lastCommitMessage: null,
										lastCheckpointAt: null,
									},
								})

								await bridge.emit({
									type: "log",
									level: "done",
									message: `GitHub repo created: ${repo.htmlUrl}`,
									ts: ts(),
								})
							} else {
								console.warn(`[session:${sessionId}] Failed to create GitHub repo`)
							}
						} catch (err) {
							console.error(`[session:${sessionId}] GitHub repo creation error:`, err)
						}
					}

					// Write CLAUDE.md to the sandbox workspace.
					// Our generator includes hardcoded playbook paths and reading order
					// so we don't depend on @tanstack/intent generating a skill block.
					const claudeMd = generateClaudeMd({
						description: body.description,
						projectName,
						projectDir: handle.projectDir,
						runtime: config.sandbox.runtime,
						production: !config.devMode,
						...(prodGitConfig
							? { git: prodGitConfig }
							: repoConfig
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

		const body = await validateBody(c, iterateSessionSchema)
		if (isResponse(body)) return body

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

	// Generate a GitHub installation token for the sandbox (prod mode only)
	app.post("/api/sessions/:id/github-token", async (c) => {
		const sessionId = c.req.param("id")

		if (config.devMode) {
			return c.json({ error: "Not available in dev mode" }, 403)
		}

		if (!GITHUB_APP_ID || !GITHUB_INSTALLATION_ID || !GITHUB_PRIVATE_KEY) {
			return c.json({ error: "GitHub App not configured" }, 500)
		}

		if (!checkGithubTokenRateLimit(sessionId)) {
			return c.json({ error: "Too many token requests" }, 429)
		}

		try {
			const result = await getInstallationToken(
				GITHUB_APP_ID,
				GITHUB_INSTALLATION_ID,
				GITHUB_PRIVATE_KEY,
			)
			return c.json(result)
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error"
			console.error(`GitHub token error for session ${sessionId}:`, message)
			return c.json({ error: "Failed to generate GitHub token" }, 500)
		}
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
		const body = await validateBody(c, createSandboxSchema)
		if (isResponse(body)) return body

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

	// --- Room Routes (agent-to-agent messaging) ---

	// Extract room token from X-Room-Token header or ?token= query param.
	// This is separate from extractToken() (which reads Authorization) so that
	// Authorization remains available for session tokens on endpoints that need both.
	function extractRoomToken(c: {
		req: {
			header: (name: string) => string | undefined
			query: (name: string) => string | undefined
		}
	}): string | undefined {
		return c.req.header("X-Room-Token") ?? c.req.query("token") ?? undefined
	}

	// Protect room-scoped routes via X-Room-Token header
	// "create-app" is a creation endpoint — no room token exists yet
	const roomAuthExemptIds = new Set(["create-app"])

	app.use("/api/rooms/:id/*", async (c, next) => {
		const id = c.req.param("id")
		if (roomAuthExemptIds.has(id)) return next()
		const token = extractRoomToken(c)
		if (!token || !validateRoomToken(config.streamConfig.secret, id, token)) {
			return c.json({ error: "Invalid or missing room token" }, 401)
		}
		return next()
	})

	app.use("/api/rooms/:id", async (c, next) => {
		const id = c.req.param("id")
		if (roomAuthExemptIds.has(id)) return next()
		if (c.req.method !== "GET" && c.req.method !== "DELETE") return next()
		const token = extractRoomToken(c)
		if (!token || !validateRoomToken(config.streamConfig.secret, id, token)) {
			return c.json({ error: "Invalid or missing room token" }, 401)
		}
		return next()
	})

	// Create a room with 3 agents for multi-agent app creation
	app.post("/api/rooms/create-app", async (c) => {
		const body = await validateBody(c, createAppRoomSchema)
		if (isResponse(body)) return body

		// In prod mode, use server-side API key; ignore user-provided credentials
		const apiKey = config.devMode ? body.apiKey : process.env.ANTHROPIC_API_KEY
		const oauthToken = config.devMode ? body.oauthToken : undefined
		const ghToken = config.devMode ? body.ghToken : undefined

		// Rate-limit session creation in production mode
		if (!config.devMode) {
			const ip = extractClientIp(c)
			if (!checkSessionRateLimit(ip)) {
				return c.json({ error: "Too many sessions. Please try again later." }, 429)
			}
			if (checkGlobalSessionCap(config.sessions)) {
				return c.json({ error: "Service at capacity, please try again later" }, 503)
			}
		}

		const roomId = crypto.randomUUID()
		const roomName = body.name || `app-${roomId.slice(0, 8)}`

		// Create the room's durable stream
		const roomConn = roomStream(config, roomId)
		try {
			await DurableStream.create({
				url: roomConn.url,
				headers: roomConn.headers,
				contentType: "application/json",
			})
		} catch (err) {
			console.error(`[room:create-app] Failed to create room stream:`, err)
			return c.json({ error: "Failed to create room stream" }, 500)
		}

		// Create and start the router
		const router = new RoomRouter(roomId, roomName, config.streamConfig)
		await router.start()
		roomRouters.set(roomId, router)

		// Save to room registry
		const code = generateInviteCode()
		await config.rooms.addRoom({
			id: roomId,
			code,
			name: roomName,
			createdAt: new Date().toISOString(),
			revoked: false,
		})

		// Define the 3 agents with randomized display names
		const agentSuffixes = [
			"fox",
			"owl",
			"lynx",
			"wolf",
			"bear",
			"hawk",
			"pine",
			"oak",
			"elm",
			"ivy",
			"ray",
			"arc",
			"reef",
			"dusk",
			"ash",
			"sage",
		]
		const pick = () => agentSuffixes[Math.floor(Math.random() * agentSuffixes.length)]
		const usedSuffixes = new Set<string>()
		const uniquePick = () => {
			let s = pick()
			while (usedSuffixes.has(s)) s = pick()
			usedSuffixes.add(s)
			return s
		}
		const agentDefs = [
			{ name: `coder-${uniquePick()}`, role: "coder" },
			{ name: `reviewer-${uniquePick()}`, role: "reviewer" },
			{ name: `designer-${uniquePick()}`, role: "ui-designer" },
		] as const

		// Create session IDs and streams upfront for all 3 agents
		const sessions: { name: string; role: string; sessionId: string; sessionToken: string }[] = []
		for (const agentDef of agentDefs) {
			const sessionId = crypto.randomUUID()
			const conn = sessionStream(config, sessionId)
			try {
				await DurableStream.create({
					url: conn.url,
					headers: conn.headers,
					contentType: "application/json",
				})
			} catch (err) {
				console.error(`[room:create-app] Failed to create stream for ${agentDef.name}:`, err)
				return c.json({ error: `Failed to create stream for ${agentDef.name}` }, 500)
			}

			const sessionToken = deriveSessionToken(config.streamConfig.secret, sessionId)
			sessions.push({ name: agentDef.name, role: agentDef.role, sessionId, sessionToken })
		}

		const roomToken = deriveRoomToken(config.streamConfig.secret, roomId)
		console.log(
			`[room:create-app] Created room ${roomId} with agents: ${sessions.map((s) => s.name).join(", ")}`,
		)

		// Return immediately so the client can show the room + sessions
		// The async flow handles sandbox creation, skill injection, and agent startup
		// Sessions are created in agentDefs order: [coder, reviewer, ui-designer]
		const coderSession = sessions[0]
		const reviewerSession = sessions[1]
		const uiDesignerSession = sessions[2]
		const coderBridge = getOrCreateBridge(config, coderSession.sessionId)

		// Record all sessions
		for (const s of sessions) {
			const projectName =
				s.role === "coder"
					? config.devMode
						? body.name ||
							body.description
								.slice(0, 40)
								.replace(/[^a-z0-9]+/gi, "-")
								.replace(/^-|-$/g, "")
								.toLowerCase()
						: `electric-${s.sessionId.slice(0, 8)}`
					: `room-${s.name}-${s.sessionId.slice(0, 8)}`
			const sandboxProjectDir = `/home/agent/workspace/${projectName}`
			const session: SessionInfo = {
				id: s.sessionId,
				projectName,
				sandboxProjectDir,
				description: s.role === "coder" ? body.description : `Room agent: ${s.name} (${s.role})`,
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: "running",
			}
			config.sessions.add(session)
		}

		// Write user prompt to coder's stream
		await coderBridge.emit({ type: "user_prompt", message: body.description, ts: ts() })

		// Gather GitHub accounts for the infra config gate (dev mode only)
		let ghAccounts: { login: string; type: "user" | "org" }[] = []
		if (config.devMode && ghToken && isGhAuthenticated(ghToken)) {
			try {
				ghAccounts = ghListAccounts(ghToken)
			} catch {
				// gh not available
			}
		}

		// Emit infra config gate on coder's stream
		const coderProjectName =
			config.sessions.get(coderSession.sessionId)?.projectName ?? coderSession.name
		await coderBridge.emit({
			type: "infra_config_prompt",
			projectName: coderProjectName,
			ghAccounts,
			runtime: config.sandbox.runtime,
			ts: ts(),
		})

		// Async flow: wait for gate, create sandboxes, start agents
		const asyncFlow = async () => {
			// 1. Wait for infra config gate on coder's session
			await router.sendMessage("system", "Waiting for infrastructure configuration...")
			console.log(`[room:create-app:${roomId}] Waiting for infra_config gate...`)
			let infra: InfraConfig
			let repoConfig: {
				account: string
				repoName: string
				visibility: "public" | "private"
			} | null = null
			let claimId: string | undefined

			try {
				const gateValue = await createGate<
					InfraConfig & {
						repoAccount?: string
						repoName?: string
						repoVisibility?: "public" | "private"
						claimId?: string
					}
				>(coderSession.sessionId, "infra_config")

				console.log(`[room:create-app:${roomId}] Infra gate resolved: mode=${gateValue.mode}`)

				if (gateValue.mode === "cloud" || gateValue.mode === "claim") {
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
					config.sessions.update(coderSession.sessionId, {
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
				console.log(`[room:create-app:${roomId}] Infra gate error (defaulting to local):`, err)
				infra = { mode: "local" }
			}

			// 2. Create sandboxes in parallel
			// Coder gets full scaffold, reviewer/ui-designer get minimal
			await router.sendMessage("system", "Creating sandboxes for all agents...")
			await coderBridge.emit({
				type: "log",
				level: "build",
				message: "Creating sandboxes for all agents...",
				ts: ts(),
			})

			const sandboxOpts = (sid: string) => ({
				...(!config.devMode && {
					prodMode: {
						sessionToken: deriveSessionToken(config.streamConfig.secret, sid),
						studioUrl: resolveStudioUrl(config.port),
					},
				}),
			})

			const coderInfo = config.sessions.get(coderSession.sessionId)
			if (!coderInfo) throw new Error("Coder session not found in registry")
			const reviewerInfo = config.sessions.get(reviewerSession.sessionId)
			if (!reviewerInfo) throw new Error("Reviewer session not found in registry")
			const uiDesignerInfo = config.sessions.get(uiDesignerSession.sessionId)
			if (!uiDesignerInfo) throw new Error("UI designer session not found in registry")

			const [coderHandle, reviewerHandle, uiDesignerHandle] = await Promise.all([
				config.sandbox.create(coderSession.sessionId, {
					projectName: coderInfo.projectName,
					infra,
					apiKey,
					oauthToken,
					ghToken,
					...sandboxOpts(coderSession.sessionId),
				}),
				config.sandbox.create(reviewerSession.sessionId, {
					projectName: reviewerInfo.projectName,
					infra: { mode: "none" },
					apiKey,
					oauthToken,
					ghToken,
					...sandboxOpts(reviewerSession.sessionId),
				}),
				config.sandbox.create(uiDesignerSession.sessionId, {
					projectName: uiDesignerInfo.projectName,
					infra: { mode: "none" },
					apiKey,
					oauthToken,
					ghToken,
					...sandboxOpts(uiDesignerSession.sessionId),
				}),
			])

			const handles = [
				{ session: coderSession, handle: coderHandle },
				{ session: reviewerSession, handle: reviewerHandle },
				{ session: uiDesignerSession, handle: uiDesignerHandle },
			]

			// Update session info with sandbox details
			for (const { session: s, handle } of handles) {
				config.sessions.update(s.sessionId, {
					appPort: handle.port,
					sandboxProjectDir: handle.projectDir,
					previewUrl: handle.previewUrl,
					...(s.role === "coder" && claimId ? { claimId } : {}),
				})
			}

			await coderBridge.emit({
				type: "log",
				level: "done",
				message: "All sandboxes ready",
				ts: ts(),
			})

			// 3. Set up coder sandbox (full scaffold + CLAUDE.md + skills + GitHub repo)
			{
				const handle = coderHandle

				// Copy scaffold
				await coderBridge.emit({
					type: "log",
					level: "build",
					message: "Setting up project...",
					ts: ts(),
				})
				try {
					if (config.sandbox.runtime === "docker") {
						await config.sandbox.exec(handle, `cp -r /opt/scaffold-base '${handle.projectDir}'`)
						await config.sandbox.exec(
							handle,
							`cd '${handle.projectDir}' && sed -i 's/"name": "scaffold-base"/"name": "${coderInfo.projectName.replace(/[^a-z0-9_-]/gi, "-")}"/' package.json`,
						)
					} else {
						await config.sandbox.exec(
							handle,
							`source /etc/profile.d/npm-global.sh 2>/dev/null; electric-agent scaffold '${handle.projectDir}' --name '${coderInfo.projectName}' --skip-git`,
						)
					}
					await coderBridge.emit({
						type: "log",
						level: "done",
						message: "Project ready",
						ts: ts(),
					})
				} catch (err) {
					console.error(`[room:create-app:${roomId}] Project setup failed:`, err)
					await coderBridge.emit({
						type: "log",
						level: "error",
						message: `Project setup failed: ${err instanceof Error ? err.message : "unknown"}`,
						ts: ts(),
					})
				}

				// GitHub repo creation (prod mode)
				let repoUrl: string | null = null
				let prodGitConfig: { mode: "pre-created"; repoName: string; repoUrl: string } | undefined
				if (!config.devMode && GITHUB_APP_ID && GITHUB_INSTALLATION_ID && GITHUB_PRIVATE_KEY) {
					try {
						const repoSlug = coderInfo.projectName

						await coderBridge.emit({
							type: "log",
							level: "build",
							message: "Creating GitHub repository...",
							ts: ts(),
						})

						const { token } = await getInstallationToken(
							GITHUB_APP_ID,
							GITHUB_INSTALLATION_ID,
							GITHUB_PRIVATE_KEY,
						)
						const repo = await createOrgRepo(GITHUB_ORG, repoSlug, token)

						if (repo) {
							const actualRepoName = `${GITHUB_ORG}/${repo.htmlUrl.split("/").pop()}`
							await config.sandbox.exec(
								handle,
								`cd '${handle.projectDir}' && git init -b main && git remote add origin '${repo.cloneUrl}'`,
							)
							prodGitConfig = {
								mode: "pre-created" as const,
								repoName: actualRepoName,
								repoUrl: repo.htmlUrl,
							}
							repoUrl = repo.htmlUrl

							config.sessions.update(coderSession.sessionId, {
								git: {
									branch: "main",
									remoteUrl: repo.htmlUrl,
									repoName: actualRepoName,
									lastCommitHash: null,
									lastCommitMessage: null,
									lastCheckpointAt: null,
								},
							})

							await coderBridge.emit({
								type: "log",
								level: "done",
								message: `GitHub repo created: ${repo.htmlUrl}`,
								ts: ts(),
							})
						}
					} catch (err) {
						console.error(`[room:create-app:${roomId}] GitHub repo creation error:`, err)
					}
				} else if (repoConfig) {
					repoUrl = `https://github.com/${repoConfig.account}/${repoConfig.repoName}`
				}

				// Write CLAUDE.md to coder sandbox
				const claudeMd = generateClaudeMd({
					description: body.description,
					projectName: coderInfo.projectName,
					projectDir: handle.projectDir,
					runtime: config.sandbox.runtime,
					production: !config.devMode,
					...(prodGitConfig
						? { git: prodGitConfig }
						: repoConfig
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
					console.error(`[room:create-app:${roomId}] Failed to write CLAUDE.md:`, err)
				}

				// Write create-app skill to coder sandbox
				if (createAppSkillContent) {
					try {
						const skillDir = `${handle.projectDir}/.claude/skills/create-app`
						const skillB64 = Buffer.from(createAppSkillContent).toString("base64")
						await config.sandbox.exec(
							handle,
							`mkdir -p '${skillDir}' && echo '${skillB64}' | base64 -d > '${skillDir}/SKILL.md'`,
						)
					} catch (err) {
						console.error(`[room:create-app:${roomId}] Failed to write create-app skill:`, err)
					}
				}

				// Write room-messaging skill to coder sandbox
				if (roomMessagingSkillContent) {
					try {
						const skillDir = `${handle.projectDir}/.claude/skills/room-messaging`
						const skillB64 = Buffer.from(roomMessagingSkillContent).toString("base64")
						await config.sandbox.exec(
							handle,
							`mkdir -p '${skillDir}' && echo '${skillB64}' | base64 -d > '${skillDir}/SKILL.md'`,
						)
					} catch (err) {
						console.error(
							`[room:create-app:${roomId}] Failed to write room-messaging skill to coder:`,
							err,
						)
					}
				}

				// 4. Create Claude Code bridge for coder
				const coderPrompt = `/create-app ${body.description}`
				const coderHookToken = deriveHookToken(config.streamConfig.secret, coderSession.sessionId)
				const coderClaudeConfig: ClaudeCodeDockerConfig | ClaudeCodeSpritesConfig =
					config.sandbox.runtime === "sprites"
						? {
								prompt: coderPrompt,
								cwd: handle.projectDir,
								studioUrl: resolveStudioUrl(config.port),
								hookToken: coderHookToken,
							}
						: {
								prompt: coderPrompt,
								cwd: handle.projectDir,
								studioPort: config.port,
								hookToken: coderHookToken,
							}
				const coderCcBridge = createClaudeCodeBridge(
					config,
					coderSession.sessionId,
					coderClaudeConfig,
				)

				// Track coder events
				coderCcBridge.onAgentEvent((event) => {
					if (event.type === "session_start") {
						const ccSessionId = (event as EngineEvent & { session_id?: string }).session_id
						if (ccSessionId) {
							config.sessions.update(coderSession.sessionId, {
								lastCoderSessionId: ccSessionId,
							})
						}
					}
					if (event.type === "session_end") {
						accumulateSessionCost(config, coderSession.sessionId, event)
					}
					// Route assistant_message output to the room router
					if (event.type === "assistant_message" && "text" in event) {
						router
							.handleAgentOutput(
								coderSession.sessionId,
								(event as EngineEvent & { text: string }).text,
							)
							.catch((err) => {
								console.error(`[room:create-app:${roomId}] handleAgentOutput error (coder):`, err)
							})
					}
				})

				// Coder failure handler: if coder ends without DONE, notify room
				coderCcBridge.onComplete(async (success) => {
					const updates: Partial<SessionInfo> = {
						status: success ? "complete" : "error",
					}
					try {
						const gs = await config.sandbox.gitStatus(handle, handle.projectDir)
						if (gs.initialized) {
							const existing = config.sessions.get(coderSession.sessionId)
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
						// Sandbox may be stopped
					}
					config.sessions.update(coderSession.sessionId, updates)

					if (!success) {
						router
							.handleAgentOutput(
								coderSession.sessionId,
								"@room Coder session ended unexpectedly. No DONE signal was sent.",
							)
							.catch((err) => {
								console.error(
									`[room:create-app:${roomId}] Failed to send coder failure message:`,
									err,
								)
							})
					}
				})

				await coderBridge.emit({
					type: "log",
					level: "build",
					message: `Running: claude "/create-app ${body.description}"`,
					ts: ts(),
				})

				await coderCcBridge.start()

				// Add coder as room participant
				const coderParticipant: RoomParticipant = {
					sessionId: coderSession.sessionId,
					name: "coder",
					role: "coder",
					bridge: coderCcBridge,
				}
				await router.addParticipant(coderParticipant, false)

				// Send the initial command to the coder
				await coderCcBridge.sendCommand({
					command: "new",
					description: body.description,
					projectName: coderInfo.projectName,
					baseDir: "/home/agent/workspace",
				})

				// Store the repoUrl for reviewer/ui-designer prompts
				// (we continue setting up those agents now)
				const finalRepoUrl = repoUrl

				// 5. Set up reviewer and ui-designer sandboxes
				const supportAgents = [
					{ session: reviewerSession, handle: reviewerHandle },
					{ session: uiDesignerSession, handle: uiDesignerHandle },
				]

				for (const { session: agentSession, handle: agentHandle } of supportAgents) {
					const agentBridge = getOrCreateBridge(config, agentSession.sessionId)

					// Write a minimal CLAUDE.md
					const minimalClaudeMd = "Room agent workspace"
					try {
						await config.sandbox.exec(
							agentHandle,
							`mkdir -p '${agentHandle.projectDir}' && cat > '${agentHandle.projectDir}/CLAUDE.md' << 'CLAUDEMD_EOF'\n${minimalClaudeMd}\nCLAUDEMD_EOF`,
						)
					} catch (err) {
						console.error(
							`[room:create-app:${roomId}] Failed to write CLAUDE.md for ${agentSession.name}:`,
							err,
						)
					}

					// Write room-messaging skill
					if (roomMessagingSkillContent) {
						try {
							const skillDir = `${agentHandle.projectDir}/.claude/skills/room-messaging`
							const skillB64 = Buffer.from(roomMessagingSkillContent).toString("base64")
							await config.sandbox.exec(
								agentHandle,
								`mkdir -p '${skillDir}' && echo '${skillB64}' | base64 -d > '${skillDir}/SKILL.md'`,
							)
						} catch (err) {
							console.error(
								`[room:create-app:${roomId}] Failed to write room-messaging skill for ${agentSession.name}:`,
								err,
							)
						}
					}

					// Resolve and inject role skill
					const roleSkill = resolveRoleSkill(agentSession.role)
					if (roleSkill) {
						try {
							const skillDir = `${agentHandle.projectDir}/.claude/skills/role`
							const skillB64 = Buffer.from(roleSkill.skillContent).toString("base64")
							await config.sandbox.exec(
								agentHandle,
								`mkdir -p '${skillDir}' && echo '${skillB64}' | base64 -d > '${skillDir}/SKILL.md'`,
							)
						} catch (err) {
							console.error(
								`[room:create-app:${roomId}] Failed to write role skill for ${agentSession.name}:`,
								err,
							)
						}
					}

					// Build prompt
					const repoRef = finalRepoUrl ? ` The GitHub repo is: ${finalRepoUrl}.` : ""
					const agentPrompt =
						agentSession.role === "reviewer"
							? `You are "reviewer", a code review agent in a multi-agent room. Read .claude/skills/role/SKILL.md for your role guidelines.${repoRef} Wait for the coder to send a @room DONE: message before starting any work.`
							: `You are "ui-designer", a UI design agent in a multi-agent room. Read .claude/skills/role/SKILL.md for your role guidelines.${repoRef} Wait for the coder to send a @room DONE: message before starting any work.`

					// Create Claude Code bridge
					const agentHookToken = deriveHookToken(config.streamConfig.secret, agentSession.sessionId)
					const agentClaudeConfig: ClaudeCodeDockerConfig | ClaudeCodeSpritesConfig =
						config.sandbox.runtime === "sprites"
							? {
									prompt: agentPrompt,
									cwd: agentHandle.projectDir,
									studioUrl: resolveStudioUrl(config.port),
									hookToken: agentHookToken,
									agentName: agentSession.name,
									...(roleSkill?.allowedTools && {
										allowedTools: roleSkill.allowedTools,
									}),
								}
							: {
									prompt: agentPrompt,
									cwd: agentHandle.projectDir,
									studioPort: config.port,
									hookToken: agentHookToken,
									agentName: agentSession.name,
									...(roleSkill?.allowedTools && {
										allowedTools: roleSkill.allowedTools,
									}),
								}
					const ccBridge = createClaudeCodeBridge(config, agentSession.sessionId, agentClaudeConfig)

					// Track events
					ccBridge.onAgentEvent((event) => {
						if (event.type === "session_start") {
							const ccSessionId = (event as EngineEvent & { session_id?: string }).session_id
							if (ccSessionId) {
								config.sessions.update(agentSession.sessionId, {
									lastCoderSessionId: ccSessionId,
								})
							}
						}
						if (event.type === "session_end") {
							accumulateSessionCost(config, agentSession.sessionId, event)
						}
						if (event.type === "assistant_message" && "text" in event) {
							router
								.handleAgentOutput(
									agentSession.sessionId,
									(event as EngineEvent & { text: string }).text,
								)
								.catch((err) => {
									console.error(
										`[room:create-app:${roomId}] handleAgentOutput error (${agentSession.name}):`,
										err,
									)
								})
						}
					})

					ccBridge.onComplete(async (success) => {
						config.sessions.update(agentSession.sessionId, {
							status: success ? "complete" : "error",
						})
					})

					await agentBridge.emit({
						type: "log",
						level: "done",
						message: `Sandbox ready for "${agentSession.name}"`,
						ts: ts(),
					})

					await ccBridge.start()

					// Add as room participant (gated — waits for room messages)
					const participant: RoomParticipant = {
						sessionId: agentSession.sessionId,
						name: agentSession.name,
						role: agentSession.role,
						bridge: ccBridge,
					}
					await router.addParticipant(participant, true)
				}

				console.log(`[room:create-app:${roomId}] All 3 agents started and added to room`)
				await router.sendMessage(
					"system",
					`All agents are ready. ${coderSession.name} is building the app. ${reviewerSession.name} and ${uiDesignerSession.name} are waiting for completion.`,
				)
			}
		}

		asyncFlow().catch(async (err) => {
			console.error(`[room:create-app:${roomId}] Flow failed:`, err)
			for (const s of sessions) {
				config.sessions.update(s.sessionId, { status: "error" })
			}
			try {
				await coderBridge.emit({
					type: "log",
					level: "error",
					message: `Room creation failed: ${err instanceof Error ? err.message : String(err)}`,
					ts: ts(),
				})
			} catch {
				// Bridge may not be usable
			}
		})

		return c.json(
			{
				roomId,
				code,
				name: roomName,
				roomToken,
				sessions: sessions.map((s) => ({
					sessionId: s.sessionId,
					name: s.name,
					role: s.role,
					sessionToken: s.sessionToken,
				})),
			},
			201,
		)
	})

	// Create a room
	app.post("/api/rooms", async (c) => {
		const body = await validateBody(c, createRoomSchema)
		if (isResponse(body)) return body

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

		const roomToken = deriveRoomToken(config.streamConfig.secret, roomId)
		console.log(`[room] Created: id=${roomId} name=${body.name} code=${code}`)
		return c.json({ roomId, code, roomToken }, 201)
	})

	// Join an agent room by id + invite code (outside /api/rooms/:id to avoid auth middleware)
	app.get("/api/join-room/:id/:code", (c) => {
		const id = c.req.param("id")
		const code = c.req.param("code")
		const room = config.rooms.getRoom(id)
		if (!room || room.code !== code) return c.json({ error: "Room not found" }, 404)
		if (room.revoked) return c.json({ error: "Room has been revoked" }, 410)

		const roomToken = deriveRoomToken(config.streamConfig.secret, room.id)
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

		const body = await validateBody(c, addAgentSchema)
		if (isResponse(body)) return body

		// Rate-limit and gate credentials in production mode
		if (!config.devMode) {
			const ip = extractClientIp(c)
			if (!checkSessionRateLimit(ip)) {
				return c.json({ error: "Too many sessions. Please try again later." }, 429)
			}
			if (checkGlobalSessionCap(config.sessions)) {
				return c.json({ error: "Service at capacity, please try again later" }, 503)
			}
		}
		const apiKey = config.devMode ? body.apiKey : process.env.ANTHROPIC_API_KEY
		const oauthToken = config.devMode ? body.oauthToken : undefined
		const ghToken = config.devMode ? body.ghToken : undefined

		const sessionId = crypto.randomUUID()
		const randomSuffix = sessionId.slice(0, 6)
		const agentName = body.name?.trim() || `agent-${randomSuffix}`
		const projectName = `room-${agentName}-${sessionId.slice(0, 8)}`

		console.log(`[room:${roomId}] Adding agent: name=${agentName} session=${sessionId}`)

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
			description: `Room agent: ${agentName} (${body.role ?? "participant"})`,
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
				message: `Creating sandbox for room agent "${agentName}"...`,
				ts: ts(),
			})

			try {
				const handle = await config.sandbox.create(sessionId, {
					projectName,
					infra: { mode: "local" },
					apiKey,
					oauthToken,
					ghToken,
					...(!config.devMode && {
						prodMode: {
							sessionToken: deriveSessionToken(config.streamConfig.secret, sessionId),
							studioUrl: resolveStudioUrl(config.port),
						},
					}),
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
				const agentPrompt = `You are "${agentName}"${body.role ? `, role: ${body.role}` : ""}. You are joining a multi-agent room.${rolePromptSuffix}`

				// Create Claude Code bridge (with role-specific tool permissions)
				const agentHookToken = deriveHookToken(config.streamConfig.secret, sessionId)
				const claudeConfig: ClaudeCodeDockerConfig | ClaudeCodeSpritesConfig =
					config.sandbox.runtime === "sprites"
						? {
								prompt: agentPrompt,
								cwd: handle.projectDir,
								studioUrl: resolveStudioUrl(config.port),
								hookToken: agentHookToken,
								agentName: agentName,
								...(roleSkill?.allowedTools && { allowedTools: roleSkill.allowedTools }),
							}
						: {
								prompt: agentPrompt,
								cwd: handle.projectDir,
								studioPort: config.port,
								hookToken: agentHookToken,
								agentName: agentName,
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
					message: `Sandbox ready for "${agentName}"`,
					ts: ts(),
				})

				await ccBridge.start()

				// Add participant to room router
				const participant: RoomParticipant = {
					sessionId,
					name: agentName,
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

		return c.json({ sessionId, participantName: agentName, sessionToken }, 201)
	})

	// Add an existing running session to a room
	app.post("/api/rooms/:id/sessions", async (c) => {
		const roomId = c.req.param("id")
		const router = roomRouters.get(roomId)
		if (!router) return c.json({ error: "Room not found" }, 404)

		const body = await validateBody(c, addSessionToRoomSchema)
		if (isResponse(body)) return body

		const { sessionId } = body

		// Require a valid session token — caller must already own this session.
		// Room auth is handled by middleware via X-Room-Token; Authorization
		// carries the session ownership proof here.
		const authHeader = c.req.header("Authorization")
		const sessionToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined
		if (
			!sessionToken ||
			!validateSessionToken(config.streamConfig.secret, sessionId, sessionToken)
		) {
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

		const body = await validateBody(c, iterateRoomSessionSchema)
		if (isResponse(body)) return body

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

		const body = await validateBody(c, sendRoomMessageSchema)
		if (isResponse(body)) return body

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
		const event: RoomEvent = {
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

	// --- Stream Append Proxy ---

	// Proxy endpoint for writing events to a session's durable stream.
	// Authenticates via session token so the caller never needs DS_SECRET.
	// Used by sandbox agents to write events back to the session stream.
	app.post("/api/sessions/:id/stream/append", async (c) => {
		const sessionId = c.req.param("id")

		const contentType = c.req.header("content-type") ?? ""
		if (!contentType.includes("application/json")) {
			return c.json({ error: "Content-Type must be application/json" }, 415)
		}

		const body = await c.req.text()
		if (!body) {
			return c.json({ error: "Request body is required" }, 400)
		}

		// Guard against oversized payloads (64 KB limit)
		if (body.length > 65_536) {
			return c.json({ error: "Payload too large" }, 413)
		}

		// Validate JSON before forwarding to the stream
		try {
			JSON.parse(body)
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400)
		}

		const connection = sessionStream(config, sessionId)
		try {
			const writer = new DurableStream({
				url: connection.url,
				headers: connection.headers,
				contentType: "application/json",
			})
			await writer.append(body)
			return c.json({ ok: true })
		} catch (err) {
			console.error(`[stream-proxy] Append failed: session=${sessionId}`, err)
			return c.json({ error: "Failed to append to stream" }, 500)
		}
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
		const resolvedPath = path.resolve(filePath)
		const resolvedDir = path.resolve(sandboxDir) + path.sep
		if (!resolvedPath.startsWith(resolvedDir) && resolvedPath !== path.resolve(sandboxDir)) {
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
		if (!config.devMode) return c.json({ error: "Not available" }, 403)
		const token = c.req.header("X-GH-Token")
		if (!token) return c.json({ accounts: [] })
		try {
			const accounts = ghListAccounts(token)
			return c.json({ accounts })
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : "Failed to list accounts" }, 500)
		}
	})

	// List GitHub repos for the authenticated user — requires client-provided token (dev mode only)
	app.get("/api/github/repos", (c) => {
		if (!config.devMode) return c.json({ error: "Not available" }, 403)
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
		if (!config.devMode) return c.json({ error: "Not available" }, 403)
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

	// Read Claude credentials from macOS Keychain (dev convenience).
	// Disabled by default — enable via devMode: true or STUDIO_DEV_MODE=1.
	if (config.devMode) {
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
					console.log(`[dev] Loaded OAuth token from keychain (length: ${token.length})`)
				} else {
					console.log("[dev] No OAuth token found in keychain")
				}
				return c.json({ oauthToken: token })
			} catch {
				return c.json({ oauthToken: null })
			}
		})
	}

	// Resume a project from a GitHub repo (dev mode only)
	app.post("/api/sessions/resume", async (c) => {
		if (!config.devMode) {
			return c.json({ error: "Resume from repo not available" }, 403)
		}

		const body = await validateBody(c, resumeSessionSchema)
		if (isResponse(body)) return body

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
				production: !config.devMode,
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
	/**
	 * Enable dev-only endpoints (e.g. macOS Keychain credential reading).
	 * Can also be enabled via the `STUDIO_DEV_MODE=1` environment variable.
	 * SECURITY: Never enable in production — the keychain endpoint exposes OAuth tokens.
	 */
	devMode?: boolean
}): Promise<void> {
	const devMode = opts.devMode ?? process.env.STUDIO_DEV_MODE === "1"
	if (devMode) {
		console.log("[studio] Dev mode enabled — keychain endpoint active")
	}
	const config: ServerConfig = {
		port: opts.port ?? 4400,
		dataDir: opts.dataDir ?? path.resolve(process.cwd(), ".electric-agent"),
		sessions: new ActiveSessions(),
		rooms: opts.rooms,
		sandbox: opts.sandbox,
		streamConfig: opts.streamConfig,
		bridgeMode: opts.bridgeMode ?? "claude-code",
		devMode,
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
