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
import { bridgeContainerToStream } from "./container-bridge.js"
import { createGate, rejectAllGates, resolveGate } from "./gate.js"
import { getStreamServerUrl } from "./infra.js"
import type { InfraConfig, SandboxProvider } from "./sandbox/index.js"
import {
	addSession,
	deleteSession,
	getSession,
	readSessionIndex,
	type SessionInfo,
	updateSessionInfo,
} from "./sessions.js"

interface ServerConfig {
	port: number
	streamsPort: number
	dataDir: string
	sandbox: SandboxProvider
}

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

function streamUrl(streamsPort: number, sessionId: string): string {
	return `${getStreamServerUrl(streamsPort)}/session/${sessionId}`
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
		const promptStream = new DurableStream({ url, contentType: "application/json" })
		await promptStream.append(
			JSON.stringify({ type: "user_message", message: body.description, ts: ts() }),
		)

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
		await promptStream.append(
			JSON.stringify({ type: "infra_config_prompt", projectName, ghAccounts, ts: ts() }),
		)

		// Launch async flow: wait for setup gate → create sandbox → start agent
		const asyncFlow = async () => {
			// 1. Wait for combined infra + repo config
			let infra: InfraConfig
			let repoConfig: {
				account: string
				repoName: string
				visibility: "public" | "private"
			} | null = null

			try {
				const gateValue = await createGate<
					InfraConfig & {
						repoAccount?: string
						repoName?: string
						repoVisibility?: "public" | "private"
					}
				>(sessionId, "infra_config")

				if (gateValue.mode === "cloud") {
					infra = {
						mode: "cloud",
						databaseUrl: gateValue.databaseUrl,
						electricUrl: gateValue.electricUrl,
						sourceId: gateValue.sourceId,
						secret: gateValue.secret,
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
			} catch {
				infra = { mode: "local" }
			}

			// 2. Create sandbox with the chosen infra
			const handle = await config.sandbox.create(sessionId, { projectName, infra })
			updateSessionInfo(config.dataDir, sessionId, {
				appPort: handle.port,
				sandboxProjectDir: handle.projectDir,
			})

			// 4. Log repo config (gh auth is validated when the git agent runs after scaffold)
			if (repoConfig) {
				const ghStream = new DurableStream({ url, contentType: "application/json" })
				await ghStream.append(
					JSON.stringify({
						type: "log",
						level: "done",
						message: `GitHub repo: ${repoConfig.account}/${repoConfig.repoName} (${repoConfig.visibility}) — will be created after scaffolding`,
						ts: ts(),
					}),
				)
			}

			// 5. Bridge container stdout → durable stream
			// When the initial "new" command completes (session_complete), create the repo and push
			const capturedRepoConfig = repoConfig
			let repoCreationSent = false
			bridgeContainerToStream(sessionId, handle.process, url, (success) => {
				const updates: Partial<SessionInfo> = {
					status: success ? "complete" : "error",
				}
				try {
					const gs = config.sandbox.gitStatus(handle, handle.projectDir)
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

				// After scaffold completes, create the GitHub repo and push (once only)
				if (capturedRepoConfig && !repoCreationSent && success && !handle.process.killed) {
					repoCreationSent = true
					const fullRepoName = `${capturedRepoConfig.account}/${capturedRepoConfig.repoName}`
					config.sandbox.sendCommand(handle, {
						command: "git",
						projectDir: handle.projectDir,
						gitOp: "create-repo",
						gitRepoName: fullRepoName,
						gitRepoVisibility: capturedRepoConfig.visibility,
					})
				}
			})

			// 6. Send the new command — git init happens automatically via scaffold
			config.sandbox.sendCommand(handle, {
				command: "new",
				description: body.description,
				projectName,
				baseDir: "/home/agent/workspace",
			})
		}

		asyncFlow().catch((err) => {
			console.error("[server] session creation flow failed:", err)
			updateSessionInfo(config.dataDir, sessionId, { status: "error" })
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
			const url = streamUrl(config.streamsPort, sessionId)
			const opStream = new DurableStream({ url, contentType: "application/json" })
			await opStream.append(
				JSON.stringify({ type: "user_message", message: body.request, ts: ts() }),
			)

			try {
				const handle = config.sandbox.get(sessionId)
				if (isStopCmd) {
					if (handle && !handle.process.killed) await config.sandbox.stopApp(handle)
					await opStream.append(
						JSON.stringify({ type: "log", level: "done", message: "App stopped", ts: ts() }),
					)
				} else {
					if (!handle || handle.process.killed) {
						return c.json({ error: "Container is not running" }, 400)
					}
					if (isRestartCmd) await config.sandbox.stopApp(handle)
					await config.sandbox.startApp(handle)
					await opStream.append(
						JSON.stringify({
							type: "log",
							level: "done",
							message: "App started",
							ts: ts(),
						}),
					)
					await opStream.append(
						JSON.stringify({ type: "app_ready", port: session.appPort, ts: ts() }),
					)
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Operation failed"
				await opStream.append(
					JSON.stringify({ type: "log", level: "error", message: msg, ts: ts() }),
				)
			}
			return c.json({ ok: true })
		}

		const handle = config.sandbox.get(sessionId)
		if (!handle || handle.process.killed) {
			return c.json({ error: "Container is not running" }, 400)
		}

		// Write user prompt to the stream
		const url = streamUrl(config.streamsPort, sessionId)
		const promptStream = new DurableStream({ url, contentType: "application/json" })
		await promptStream.append(
			JSON.stringify({ type: "user_message", message: body.request, ts: ts() }),
		)

		updateSessionInfo(config.dataDir, sessionId, { status: "running" })

		config.sandbox.sendCommand(handle, {
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

		// Forward agent gate responses to container stdin
		if (!serverGates.has(gate)) {
			const handle = config.sandbox.get(sessionId)
			if (!handle) {
				return c.json({ error: "No active container found" }, 404)
			}
			const { gate: _, _summary: _s, ...value } = body
			config.sandbox.sendGateResponse(handle, gate, value as Record<string, unknown>)

			// Persist gate resolution for replay
			try {
				const sUrl = streamUrl(config.streamsPort, sessionId)
				const s = new DurableStream({ url: sUrl, contentType: "application/json" })
				await s.append(JSON.stringify({ type: "gate_resolved", gate, summary, ts: ts() }))
			} catch {
				// Non-critical
			}
			return c.json({ ok: true })
		}

		// Resolve in-process gate
		let value: unknown
		switch (gate) {
			case "infra_config":
				if (body.mode === "cloud") {
					value = {
						mode: "cloud",
						databaseUrl: body.databaseUrl,
						electricUrl: body.electricUrl,
						sourceId: body.sourceId,
						secret: body.secret,
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
			const sUrl = streamUrl(config.streamsPort, sessionId)
			const s = new DurableStream({ url: sUrl, contentType: "application/json" })
			await s.append(JSON.stringify({ type: "gate_resolved", gate, summary, ts: ts() }))
		} catch {
			// Non-critical
		}

		console.log(`[respond] gate ${gate} resolved successfully`)
		return c.json({ ok: true })
	})

	// Check app status
	app.get("/api/sessions/:id/app-status", (c) => {
		const sessionId = c.req.param("id")
		const session = getSession(config.dataDir, sessionId)
		if (!session) return c.json({ error: "Session not found" }, 404)

		const handle = config.sandbox.get(sessionId)
		if (!handle || handle.process.killed) {
			return c.json({ running: false, port: session.appPort })
		}
		const running = config.sandbox.isAppRunning(handle)
		return c.json({ running, port: handle.port ?? session.appPort })
	})

	// Start the generated app
	app.post("/api/sessions/:id/start-app", async (c) => {
		const sessionId = c.req.param("id")
		const session = getSession(config.dataDir, sessionId)
		if (!session) return c.json({ error: "Session not found" }, 404)

		const handle = config.sandbox.get(sessionId)
		if (!handle || handle.process.killed) {
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
		if (handle && !handle.process.killed) {
			await config.sandbox.stopApp(handle)
		}
		return c.json({ success: true })
	})

	// Cancel a running session
	app.post("/api/sessions/:id/cancel", (c) => {
		const sessionId = c.req.param("id")

		const handle = config.sandbox.get(sessionId)
		if (handle) config.sandbox.destroy(handle)

		rejectAllGates(sessionId)
		updateSessionInfo(config.dataDir, sessionId, { status: "cancelled" })
		return c.json({ ok: true })
	})

	// Delete a session
	app.delete("/api/sessions/:id", (c) => {
		const sessionId = c.req.param("id")

		const handle = config.sandbox.get(sessionId)
		if (handle) config.sandbox.destroy(handle)

		rejectAllGates(sessionId)

		const deleted = deleteSession(config.dataDir, sessionId)
		if (!deleted) return c.json({ error: "Session not found" }, 404)
		return c.json({ ok: true })
	})

	// --- Git/GitHub Routes ---

	// Get git status for a session
	app.get("/api/sessions/:id/git-status", (c) => {
		const sessionId = c.req.param("id")
		const session = getSession(config.dataDir, sessionId)
		if (!session) return c.json({ error: "Session not found" }, 404)

		const handle = config.sandbox.get(sessionId)
		if (!handle) {
			return c.json({ error: "Container not available" }, 404)
		}
		try {
			const status = config.sandbox.gitStatus(
				handle,
				session.sandboxProjectDir || handle.projectDir,
			)
			return c.json(status)
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : "Failed to get git status" }, 500)
		}
	})

	// List all files in the project directory
	app.get("/api/sessions/:id/files", (c) => {
		const sessionId = c.req.param("id")
		const session = getSession(config.dataDir, sessionId)
		if (!session) return c.json({ error: "Session not found" }, 404)

		const handle = config.sandbox.get(sessionId)
		const sandboxDir = session.sandboxProjectDir
		if (!handle || !sandboxDir) {
			return c.json({ files: [], prefix: sandboxDir ?? "" })
		}
		const files = config.sandbox.listFiles(handle, sandboxDir)
		return c.json({ files, prefix: sandboxDir })
	})

	// Read a file's content
	app.get("/api/sessions/:id/file-content", (c) => {
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
		const content = config.sandbox.readFile(handle, filePath)
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
		const url = streamUrl(config.streamsPort, sessionId)
		try {
			await DurableStream.create({ url, contentType: "application/json" })
		} catch {
			return c.json({ error: "Failed to create event stream" }, 500)
		}

		try {
			const handle = await config.sandbox.createFromRepo(sessionId, body.repoUrl, {
				branch: body.branch,
			})

			// Get git state from cloned repo inside the container
			const gs = config.sandbox.gitStatus(handle, handle.projectDir)

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
			const initStream = new DurableStream({ url, contentType: "application/json" })
			await initStream.append(
				JSON.stringify({
					type: "log",
					level: "done",
					message: `Resumed from ${body.repoUrl}`,
					ts: ts(),
				}),
			)

			return c.json({ sessionId, streamUrl: url, appPort: handle.port }, 201)
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
	streamsPort?: number
	dataDir?: string
	sandbox: SandboxProvider
}): Promise<void> {
	const config: ServerConfig = {
		port: opts.port ?? 4400,
		streamsPort: opts.streamsPort ?? 4437,
		dataDir: opts.dataDir ?? path.resolve(process.cwd(), ".electric-agent"),
		sandbox: opts.sandbox,
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
