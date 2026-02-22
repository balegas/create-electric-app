import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { DurableStream } from "@durable-streams/client"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { inferProjectName } from "../agents/clarifier.js"
import { ts } from "../engine/events.js"
import { resolveProjectDir } from "../engine/orchestrator.js"
import {
	ghListAccounts,
	ghListBranches,
	ghListRepos,
	isGhAuthenticated,
	validateGhToken,
} from "../git/index.js"
import { DaytonaSessionBridge } from "./bridge/daytona.js"
import { DockerStdioBridge } from "./bridge/docker-stdio.js"
import { HostedStreamBridge } from "./bridge/hosted.js"
import type { SessionBridge } from "./bridge/types.js"
import { DEFAULT_ELECTRIC_URL, getClaimUrl, provisionElectricResources } from "./electric-api.js"
import { createGate, rejectAllGates, resolveGate } from "./gate.js"
import type { DaytonaSandboxProvider as DaytonaSandboxProviderType } from "./sandbox/daytona.js"
import type { DockerSandboxProvider as DockerSandboxProviderType } from "./sandbox/docker.js"
import type { InfraConfig, SandboxProvider } from "./sandbox/index.js"
import {
	addSession,
	deleteSession,
	getSession,
	readSessionIndex,
	type SessionInfo,
	updateSessionInfo,
} from "./sessions.js"
import {
	getStreamConnectionInfo,
	getStreamEnvVars,
	type StreamConfig,
	type StreamConnectionInfo,
} from "./streams.js"

type BridgeMode = "stream" | "stdio"

interface ServerConfig {
	port: number
	dataDir: string
	sandbox: SandboxProvider
	/** Hosted stream config — required */
	streamConfig: StreamConfig
	/** Bridge mode: "stream" (hosted DS, default) or "stdio" (stdin/stdout via SDK/Docker) */
	bridgeMode: BridgeMode
}

/** Active session bridges — one per running session */
const bridges = new Map<string, SessionBridge>()

/** Check if the Claude CLI is installed and authenticated (OAuth) */
function hasClaudeCliAuth(): boolean {
	try {
		const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude")
		if (!fs.existsSync(configDir)) return false
		execFileSync("claude", ["--version"], { stdio: "ignore", timeout: 3000 })
		return true
	} catch {
		return false
	}
}

function parseRepoNameFromUrl(url: string | null): string | null {
	if (!url) return null
	const match = url.match(/github\.com[/:](.+?)(?:\.git)?$/)
	return match?.[1] ?? null
}

/** Get stream connection info for a session (URL + auth headers) */
function sessionStream(config: ServerConfig, sessionId: string): StreamConnectionInfo {
	return getStreamConnectionInfo(sessionId, config.streamConfig)
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
 * Create a stdio-based bridge for a session after the sandbox has been created.
 * Replaces any existing hosted bridge for the session.
 */
function createStdioBridge(config: ServerConfig, sessionId: string): SessionBridge {
	const conn = sessionStream(config, sessionId)
	let bridge: SessionBridge

	if (config.sandbox.runtime === "daytona") {
		const daytonaProvider = config.sandbox as DaytonaSandboxProviderType
		const sandbox = daytonaProvider.getSandboxObject(sessionId)
		if (!sandbox) {
			throw new Error(`No Daytona sandbox object for session ${sessionId}`)
		}
		bridge = new DaytonaSessionBridge(sessionId, conn, sandbox)
	} else {
		const dockerProvider = config.sandbox as DockerSandboxProviderType
		const containerId = dockerProvider.getContainerId(sessionId)
		if (!containerId) {
			throw new Error(`No Docker container found for session ${sessionId}`)
		}
		bridge = new DockerStdioBridge(sessionId, conn, containerId)
	}

	// Replace any existing bridge
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

export function createApp(config: ServerConfig) {
	const app = new Hono()

	// CORS for local development
	app.use("*", cors({ origin: "*" }))

	// --- API Routes ---

	// Settings
	app.get("/api/settings", (c) => {
		const hasApiKey = !!process.env.ANTHROPIC_API_KEY || hasClaudeCliAuth()
		if (!process.env.GH_TOKEN && process.env.GITHUB_TOKEN) {
			process.env.GH_TOKEN = process.env.GITHUB_TOKEN
		}
		const hasGhToken = !!process.env.GH_TOKEN || isGhAuthenticated()
		return c.json({ hasApiKey, hasGhToken })
	})

	app.put("/api/settings", async (c) => {
		const body = (await c.req.json()) as { anthropicApiKey?: string; githubPat?: string }
		if (body.anthropicApiKey) {
			process.env.ANTHROPIC_API_KEY = body.anthropicApiKey
		}
		if (body.githubPat) {
			const result = validateGhToken(body.githubPat)
			if (!result.valid) {
				return c.json({ error: result.error || "Invalid GitHub token" }, 400)
			}
			process.env.GH_TOKEN = body.githubPat
			return c.json({ ok: true, ghUsername: result.username })
		}
		return c.json({ ok: true })
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
		addSession(config.dataDir, session)

		// Write user prompt to the stream so it shows in the UI
		await bridge.emit({ type: "user_message", message: body.description, ts: ts() })

		// Gather GitHub accounts for the merged setup gate
		let ghAccounts: { login: string; type: "user" | "org" }[] = []
		if (isGhAuthenticated()) {
			try {
				ghAccounts = ghListAccounts()
			} catch {
				// gh not available — no repo setup
			}
		}

		// Emit combined infra + repo setup gate
		await bridge.emit({ type: "infra_config_prompt", projectName, ghAccounts, ts: ts() })

		// Launch async flow: wait for setup gate → create sandbox → start agent
		const asyncFlow = async () => {
			// 1. Wait for combined infra + repo config
			let infra: InfraConfig
			let repoConfig: {
				account: string
				repoName: string
				visibility: "public" | "private"
			} | null = null

			console.log(`[session:${sessionId}] Waiting for infra_config gate...`)
			let claimId: string | undefined
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
					updateSessionInfo(config.dataDir, sessionId, {
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

			// 2. Create sandbox
			// Only pass stream env vars when using hosted stream bridge (not stdio)
			const streamEnv =
				config.bridgeMode === "stdio" ? undefined : getStreamEnvVars(sessionId, config.streamConfig)
			console.log(
				`[session:${sessionId}] Creating sandbox: runtime=${config.sandbox.runtime} project=${projectName} bridgeMode=${config.bridgeMode}`,
			)
			const handle = await config.sandbox.create(sessionId, {
				projectName,
				infra,
				streamEnv,
				deferAgentStart: config.bridgeMode === "stdio",
			})
			console.log(
				`[session:${sessionId}] Sandbox created: projectDir=${handle.projectDir} port=${handle.port} previewUrl=${handle.previewUrl ?? "none"}`,
			)
			updateSessionInfo(config.dataDir, sessionId, {
				appPort: handle.port,
				sandboxProjectDir: handle.projectDir,
				previewUrl: handle.previewUrl,
				...(claimId ? { claimId } : {}),
			})

			// 3. If stdio bridge mode, create the stdio bridge now that the sandbox exists
			if (config.bridgeMode === "stdio") {
				console.log(`[session:${sessionId}] Creating stdio bridge...`)
				bridge = createStdioBridge(config, sessionId)
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
			bridge.onComplete(async (success) => {
				const updates: Partial<SessionInfo> = {
					status: success ? "complete" : "error",
				}
				try {
					const gs = await config.sandbox.gitStatus(handle, handle.projectDir)
					if (gs.initialized) {
						const existing = getSession(config.dataDir, sessionId)
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
				updateSessionInfo(config.dataDir, sessionId, updates)
			})

			console.log(`[session:${sessionId}] Starting bridge listener...`)
			await bridge.start()
			console.log(`[session:${sessionId}] Bridge started, sending 'new' command...`)

			// 5. Send the new command via the bridge
			const newCmd: Record<string, unknown> = {
				command: "new",
				description: body.description,
				projectName,
				baseDir: "/home/agent/workspace",
			}
			if (repoConfig) {
				newCmd.gitRepoName = `${repoConfig.account}/${repoConfig.repoName}`
				newCmd.gitRepoVisibility = repoConfig.visibility
			}
			await bridge.sendCommand(newCmd)
			console.log(`[session:${sessionId}] Command sent, waiting for agent...`)
		}

		asyncFlow().catch((err) => {
			console.error(`[session:${sessionId}] Session creation flow failed:`, err)
			updateSessionInfo(config.dataDir, sessionId, { status: "error" })
		})

		return c.json({ sessionId }, 201)
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
			await bridge.emit({ type: "user_message", message: body.request, ts: ts() })

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
					await bridge.emit({ type: "app_ready", port: session.appPort, ts: ts() })
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
			await bridge.emit({ type: "user_message", message: body.request, ts: ts() })

			const handle = config.sandbox.get(sessionId)
			if (!handle || !config.sandbox.isAlive(handle)) {
				return c.json({ error: "Container is not running" }, 400)
			}

			await bridge.sendCommand({
				command: "git",
				projectDir: session.sandboxProjectDir || handle.projectDir,
				...gitOp,
			})

			return c.json({ ok: true })
		}

		const handle = config.sandbox.get(sessionId)
		if (!handle || !config.sandbox.isAlive(handle)) {
			return c.json({ error: "Container is not running" }, 400)
		}

		// Write user prompt to the stream
		const bridge = getOrCreateBridge(config, sessionId)
		await bridge.emit({ type: "user_message", message: body.request, ts: ts() })

		updateSessionInfo(config.dataDir, sessionId, { status: "running" })

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
				await bridge.emit({ type: "gate_resolved", gate, summary, ts: ts() })
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

		// Persist gate resolution so replays mark the gate as resolved
		try {
			const bridge = getOrCreateBridge(config, sessionId)
			await bridge.emit({ type: "gate_resolved", gate, summary, ts: ts() })
		} catch {
			// Non-critical
		}

		console.log(`[respond] gate ${gate} resolved successfully`)
		return c.json({ ok: true })
	})

	// Check app status
	app.get("/api/sessions/:id/app-status", async (c) => {
		const sessionId = c.req.param("id")
		const session = getSession(config.dataDir, sessionId)
		if (!session) return c.json({ error: "Session not found" }, 404)

		const handle = config.sandbox.get(sessionId)
		if (!handle || !config.sandbox.isAlive(handle)) {
			return c.json({ running: false, port: session.appPort })
		}
		const running = await config.sandbox.isAppRunning(handle)
		return c.json({ running, port: handle.port ?? session.appPort })
	})

	// Start the generated app
	app.post("/api/sessions/:id/start-app", async (c) => {
		const sessionId = c.req.param("id")
		const session = getSession(config.dataDir, sessionId)
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
		const session = getSession(config.dataDir, sessionId)
		if (!session) return c.json({ error: "Session not found" }, 404)

		const handle = config.sandbox.get(sessionId)
		if (handle && config.sandbox.isAlive(handle)) {
			await config.sandbox.stopApp(handle)
		}
		return c.json({ success: true })
	})

	// Cancel a running session
	app.post("/api/sessions/:id/cancel", async (c) => {
		const sessionId = c.req.param("id")

		closeBridge(sessionId)

		const handle = config.sandbox.get(sessionId)
		if (handle) await config.sandbox.destroy(handle)

		rejectAllGates(sessionId)
		updateSessionInfo(config.dataDir, sessionId, { status: "cancelled" })
		return c.json({ ok: true })
	})

	// Delete a session
	app.delete("/api/sessions/:id", async (c) => {
		const sessionId = c.req.param("id")

		closeBridge(sessionId)

		const handle = config.sandbox.get(sessionId)
		if (handle) await config.sandbox.destroy(handle)

		rejectAllGates(sessionId)

		const deleted = deleteSession(config.dataDir, sessionId)
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
		const streamEnv = getStreamEnvVars(sessionId, config.streamConfig)
		try {
			const handle = await config.sandbox.create(sessionId, {
				projectName: body.projectName,
				infra: body.infra,
				streamEnv,
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

	// --- SSE Proxy ---

	// Server-side SSE proxy: reads from the hosted durable stream and proxies
	// events to the React client. The client never sees DS credentials.
	app.get("/api/sessions/:id/events", async (c) => {
		const sessionId = c.req.param("id")
		console.log(`[sse] Client connected: session=${sessionId}`)
		const session = getSession(config.dataDir, sessionId)
		if (!session) {
			console.log(`[sse] Session not found: ${sessionId}`)
			return c.json({ error: "Session not found" }, 404)
		}

		// Get the stream connection info
		const connection = sessionStream(config, sessionId)

		// Last-Event-ID allows reconnection from where the client left off
		const lastEventId = c.req.header("Last-Event-ID") || "-1"
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
		const session = getSession(config.dataDir, sessionId)
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
		const session = getSession(config.dataDir, sessionId)
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
		const session = getSession(config.dataDir, sessionId)
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

	// List GitHub accounts (personal + orgs)
	app.get("/api/github/accounts", (c) => {
		try {
			const accounts = ghListAccounts()
			return c.json({ accounts })
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : "Failed to list accounts" }, 500)
		}
	})

	// List GitHub repos for the authenticated user
	app.get("/api/github/repos", (c) => {
		try {
			const repos = ghListRepos()
			return c.json({ repos })
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : "Failed to list repos" }, 500)
		}
	})

	app.get("/api/github/repos/:owner/:repo/branches", (c) => {
		const owner = c.req.param("owner")
		const repo = c.req.param("repo")
		try {
			const branches = ghListBranches(`${owner}/${repo}`)
			return c.json({ branches })
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : "Failed to list branches" }, 500)
		}
	})

	// Resume a project from a GitHub repo
	app.post("/api/sessions/resume", async (c) => {
		const body = (await c.req.json()) as {
			repoUrl: string
			branch?: string
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

		try {
			const handle = await config.sandbox.createFromRepo(sessionId, body.repoUrl, {
				branch: body.branch,
			})

			// Get git state from cloned repo inside the container
			const gs = await config.sandbox.gitStatus(handle, handle.projectDir)

			const session: SessionInfo = {
				id: sessionId,
				projectName: repoName,
				sandboxProjectDir: handle.projectDir,
				description: `Resumed from ${body.repoUrl}`,
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: "complete",
				appPort: handle.port,
				git: {
					branch: gs.branch ?? body.branch ?? "main",
					remoteUrl: body.repoUrl,
					repoName: parseRepoNameFromUrl(body.repoUrl),
					lastCommitHash: gs.lastCommitHash ?? null,
					lastCommitMessage: gs.lastCommitMessage ?? null,
					lastCheckpointAt: null,
				},
			}
			addSession(config.dataDir, session)

			// Write initial message to stream
			const bridge = getOrCreateBridge(config, sessionId)
			await bridge.emit({
				type: "log",
				level: "done",
				message: `Resumed from ${body.repoUrl}`,
				ts: ts(),
			})

			return c.json({ sessionId, appPort: handle.port }, 201)
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Failed to resume from repo"
			return c.json({ error: msg }, 500)
		}
	})

	// Serve static SPA files (if built)
	const clientDir = path.resolve(
		path.dirname(new URL(import.meta.url).pathname),
		"../../dist/web/client",
	)
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
	sandbox: SandboxProvider
	streamConfig: StreamConfig
	bridgeMode?: BridgeMode
}): Promise<void> {
	const config: ServerConfig = {
		port: opts.port ?? 4400,
		dataDir: opts.dataDir ?? path.resolve(process.cwd(), ".electric-agent"),
		sandbox: opts.sandbox,
		streamConfig: opts.streamConfig,
		bridgeMode: opts.bridgeMode ?? "stream",
	}

	fs.mkdirSync(config.dataDir, { recursive: true })

	const app = createApp(config)

	serve({
		fetch: app.fetch,
		port: config.port,
		hostname: "127.0.0.1",
	})

	console.log(`Web UI server running at http://127.0.0.1:${config.port}`)
	console.log(`Streams: ${config.streamConfig.url} (service: ${config.streamConfig.serviceId})`)
}
