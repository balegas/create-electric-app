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
import { generateClaudeMd } from "./bridge/claude-md-generator.js"
import { DaytonaSessionBridge } from "./bridge/daytona.js"
import { DockerStdioBridge } from "./bridge/docker-stdio.js"
import { HostedStreamBridge } from "./bridge/hosted.js"
import { SpritesStdioBridge } from "./bridge/sprites.js"
import type { SessionBridge } from "./bridge/types.js"
import { DEFAULT_ELECTRIC_URL, getClaimUrl, provisionElectricResources } from "./electric-api.js"
import { createGate, rejectAllGates, resolveGate } from "./gate.js"
import { ghListAccounts, ghListBranches, ghListRepos, isGhAuthenticated } from "./git.js"
import { resolveProjectDir } from "./project-utils.js"
import type { RoomRegistry } from "./room-registry.js"
import type { DaytonaSandboxProvider as DaytonaSandboxProviderType } from "./sandbox/daytona.js"
import type { DockerSandboxProvider as DockerSandboxProviderType } from "./sandbox/docker.js"
import type { InfraConfig, SandboxProvider } from "./sandbox/index.js"
import type { SpritesSandboxProvider as SpritesSandboxProviderType } from "./sandbox/sprites.js"
import type { SessionInfo } from "./sessions.js"
import { generateInviteCode } from "./shared-sessions.js"
import {
	getSharedStreamConnectionInfo,
	getStreamConnectionInfo,
	getStreamEnvVars,
	type StreamConfig,
	type StreamConnectionInfo,
} from "./streams.js"

type BridgeMode = "stream" | "stdio" | "claude-code"

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
	/** Bridge mode: "stream" (hosted DS, default), "stdio" (stdin/stdout via SDK/Docker), or "claude-code" (Claude Code CLI in sandbox) */
	bridgeMode: BridgeMode
	/** Optional: infer a short project name from a description (calls an LLM). Falls back to slugified description. */
	inferProjectName?: (description: string) => Promise<string>
}

/** Active session bridges — one per running session */
const bridges = new Map<string, SessionBridge>()

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
	} else if (config.sandbox.runtime === "sprites") {
		const spritesProvider = config.sandbox as SpritesSandboxProviderType
		const sprite = spritesProvider.getSpriteObject(sessionId)
		if (!sprite) {
			throw new Error(`No Sprites sandbox object for session ${sessionId}`)
		}
		bridge = new SpritesStdioBridge(sessionId, conn, sprite)
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
							options?: Array<{ label: string; description?: string }>
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

		case "SessionEnd":
			return {
				type: "session_end",
				success: true,
				ts: now,
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

		console.log(`[local-session] Created session: ${sessionId}`)
		return c.json({ sessionId }, 201)
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

		console.log(`[auto-session] Created session: ${sessionId} (project: ${projectName})`)
		return c.json({ sessionId }, 201)
	})

	// Receive a hook event from Claude Code (via forward.sh) and write it
	// to the session's durable stream as an EngineEvent.
	// For AskUserQuestion, this blocks until the user answers in the web UI.
	app.post("/api/sessions/:id/hook-event", async (c) => {
		const sessionId = c.req.param("id")
		const body = (await c.req.json()) as Record<string, unknown>

		const bridge = getOrCreateBridge(config, sessionId)

		// Map Claude Code hook JSON → EngineEvent
		const hookEvent = mapHookToEngineEvent(body)
		if (!hookEvent) {
			return c.json({ ok: true }) // Unknown hook type — silently skip
		}

		try {
			await bridge.emit(hookEvent)
		} catch (err) {
			console.error(`[hook-event] Failed to emit:`, err)
			return c.json({ error: "Failed to write event" }, 500)
		}

		// Bump lastActiveAt on every hook event
		config.sessions.update(sessionId, {})

		// SessionEnd: mark session complete and close the bridge
		if (hookEvent.type === "session_end") {
			config.sessions.update(sessionId, { status: "complete" })
			closeBridge(sessionId)
			return c.json({ ok: true })
		}

		// AskUserQuestion: block until the user answers via the web UI
		if (hookEvent.type === "ask_user_question") {
			const toolUseId = hookEvent.tool_use_id
			console.log(`[hook-event] Blocking for ask_user_question gate: ${toolUseId}`)
			try {
				const gateTimeout = 5 * 60 * 1000 // 5 minutes
				const answer = await Promise.race([
					createGate<{ answer: string }>(sessionId, `ask_user_question:${toolUseId}`),
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
							answers: { [hookEvent.question]: answer.answer },
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
				const answer = await Promise.race([
					createGate<{ answer: string }>(sessionId, `ask_user_question:${toolUseId}`),
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
							answers: { [hookEvent.question]: answer.answer },
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
  if (!arr.some(h => h.command === hook)) {
    arr.push({ type: 'command', command: hook });
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
			apiKey?: string
			oauthToken?: string
			ghToken?: string
			/** Per-session agent mode: "electric-agent" (default) or "claude-code" */
			agentMode?: "electric-agent" | "claude-code"
		}

		if (!body.description) {
			return c.json({ error: "description is required" }, 400)
		}

		// Per-session bridge mode: "claude-code" if explicitly requested, else server default
		const sessionBridgeMode: BridgeMode =
			body.agentMode === "claude-code" ? "claude-code" : config.bridgeMode

		const sessionId = crypto.randomUUID()
		const inferredName =
			body.name ||
			(config.inferProjectName
				? await config.inferProjectName(body.description)
				: body.description
						.slice(0, 40)
						.replace(/[^a-z0-9]+/gi, "-")
						.replace(/^-|-$/g, "")
						.toLowerCase())
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
			agentMode: sessionBridgeMode === "claude-code" ? "claude-code" : "electric-agent",
		}
		config.sessions.add(session)

		// Write user prompt to the stream so it shows in the UI
		await bridge.emit({ type: "user_prompt", message: body.description, ts: ts() })

		// Gather GitHub accounts for the merged setup gate
		let ghAccounts: { login: string; type: "user" | "org" }[] = []
		if (isGhAuthenticated(body.ghToken)) {
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

			// 2. Create sandbox — emit progress events so the UI shows feedback
			await bridge.emit({
				type: "log",
				level: "build",
				message: `Creating ${config.sandbox.runtime} sandbox...`,
				ts: ts(),
			})

			// Only pass stream env vars when using hosted stream bridge (not stdio or claude-code)
			const streamEnv =
				sessionBridgeMode === "stdio" || sessionBridgeMode === "claude-code"
					? undefined
					: getStreamEnvVars(sessionId, config.streamConfig)
			console.log(
				`[session:${sessionId}] Creating sandbox: runtime=${config.sandbox.runtime} project=${projectName} bridgeMode=${sessionBridgeMode}`,
			)
			const handle = await config.sandbox.create(sessionId, {
				projectName,
				infra,
				streamEnv,
				deferAgentStart: sessionBridgeMode === "stdio" || sessionBridgeMode === "claude-code",
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

			// 3. If stdio bridge mode, create the stdio bridge now that the sandbox exists.
			// If claude-code mode, write CLAUDE.md and create a ClaudeCode bridge.
			// If stdio mode, create the stdio bridge now that the sandbox exists.
			// If stream bridge mode with Sprites, launch the agent process in the sprite
			// (it connects directly to the hosted Durable Stream via DS_URL env vars).
			if (sessionBridgeMode === "claude-code") {
				console.log(`[session:${sessionId}] Setting up Claude Code bridge...`)

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
						// Sprites/Daytona: run scaffold from globally installed electric-agent
						await config.sandbox.exec(
							handle,
							`source /etc/profile.d/npm-global.sh 2>/dev/null; electric-agent scaffold '${handle.projectDir}' --name '${projectName}' --skip-git`,
						)
					}
					// Ensure _agent/ working memory directory exists
					await config.sandbox.exec(
						handle,
						`mkdir -p '${handle.projectDir}/_agent' && echo '# Error Log\n' > '${handle.projectDir}/_agent/errors.md' && echo '# Session State\n' > '${handle.projectDir}/_agent/session.md'`,
					)
					console.log(`[session:${sessionId}] Project setup complete`)
					await bridge.emit({
						type: "log",
						level: "done",
						message: "Project ready",
						ts: ts(),
					})
				} catch (err) {
					console.error(`[session:${sessionId}] Project setup failed:`, err)
					await bridge.emit({
						type: "log",
						level: "error",
						message: `Project setup failed: ${err instanceof Error ? err.message : "unknown"}`,
						ts: ts(),
					})
				}

				// Write CLAUDE.md to the sandbox workspace
				const claudeMd = generateClaudeMd({
					description: body.description,
					projectName,
					projectDir: handle.projectDir,
					runtime: config.sandbox.runtime,
				})
				try {
					await config.sandbox.exec(
						handle,
						`cat > '${handle.projectDir}/CLAUDE.md' << 'CLAUDEMD_EOF'\n${claudeMd}\nCLAUDEMD_EOF`,
					)
				} catch (err) {
					console.error(`[session:${sessionId}] Failed to write CLAUDE.md:`, err)
				}

				const claudeConfig: ClaudeCodeDockerConfig = {
					prompt: body.description,
					cwd: handle.projectDir,
				}
				bridge = createClaudeCodeBridge(config, sessionId, claudeConfig)
			} else if (sessionBridgeMode === "stdio") {
				console.log(`[session:${sessionId}] Creating stdio bridge...`)
				bridge = createStdioBridge(config, sessionId)
			} else if (config.sandbox.runtime === "sprites") {
				await bridge.emit({
					type: "log",
					level: "build",
					message: "Starting agent in sandbox...",
					ts: ts(),
				})
				console.log(`[session:${sessionId}] Starting agent process in sprite...`)
				try {
					const spritesProvider = config.sandbox as SpritesSandboxProviderType
					await spritesProvider.startAgent(handle)
					// Give the agent time to start and connect to the stream
					await new Promise((r) => setTimeout(r, 3000))
					console.log(`[session:${sessionId}] Agent process launched in sprite`)
					await bridge.emit({
						type: "log",
						level: "done",
						message: "Agent started",
						ts: ts(),
					})
				} catch (err) {
					console.error(`[session:${sessionId}] Failed to start agent in sprite:`, err)
					await bridge.emit({
						type: "log",
						level: "error",
						message: `Failed to start agent: ${err instanceof Error ? err.message : "unknown error"}`,
						ts: ts(),
					})
				}
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

			// Track Claude Code session ID for --resume on iterate
			bridge.onAgentEvent((event) => {
				if (event.type === "session_start") {
					const ccSessionId = (event as EngineEvent & { session_id?: string }).session_id
					console.log(`[session:${sessionId}] Captured Claude Code session ID: ${ccSessionId}`)
					if (ccSessionId) {
						config.sessions.update(sessionId, { lastCoderSessionId: ccSessionId })
					}
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

				// For Claude Code mode: check if the app is running after completion
				// and emit app_ready so the UI shows the preview link
				if (sessionBridgeMode === "claude-code" && success) {
					try {
						const appRunning = await config.sandbox.isAppRunning(handle)
						if (appRunning) {
							await bridge.emit({
								type: "app_ready",
								port: handle.port ?? session.appPort,
								ts: ts(),
							})
						}
					} catch {
						// Container may already be stopped
					}
				}
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

		asyncFlow().catch(async (err) => {
			console.error(`[session:${sessionId}] Session creation flow failed:`, err)
			config.sessions.update(sessionId, { status: "error" })
		})

		return c.json({ sessionId, session }, 201)
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
			await bridge.emit({ type: "user_prompt", message: body.request, ts: ts() })

			const handle = config.sandbox.get(sessionId)
			if (!handle || !config.sandbox.isAlive(handle)) {
				return c.json({ error: "Container is not running" }, 400)
			}

			if (session.agentMode === "claude-code") {
				// In Claude Code mode, send git requests as user messages
				await bridge.sendCommand({
					command: "iterate",
					request: body.request,
				})
			} else {
				await bridge.sendCommand({
					command: "git",
					projectDir: session.sandboxProjectDir || handle.projectDir,
					...gitOp,
				})
			}

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

		// AskUserQuestion gates: resolve the blocking hook-event and emit gate_resolved
		if (gate === "ask_user_question") {
			const toolUseId = body.toolUseId as string
			if (!toolUseId) {
				return c.json({ error: "toolUseId is required for ask_user_question" }, 400)
			}
			const answer = (body.answer as string) || ""
			const resolved = resolveGate(sessionId, `ask_user_question:${toolUseId}`, { answer })
			if (!resolved) {
				return c.json({ error: "No pending ask_user_question gate found" }, 404)
			}
			// Emit gate_resolved for replay
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

	// Cancel a running session
	app.post("/api/sessions/:id/cancel", async (c) => {
		const sessionId = c.req.param("id")

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

	// --- Shared Sessions ---

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

		console.log(`[shared-session] Created: id=${id} code=${code}`)
		return c.json({ id, code }, 201)
	})

	// Resolve invite code → shared session ID
	app.get("/api/shared-sessions/join/:code", (c) => {
		const code = c.req.param("code")
		const entry = config.rooms.getRoomByCode(code)
		if (!entry) return c.json({ error: "Shared session not found" }, 404)
		return c.json({ id: entry.id, code: entry.code, revoked: entry.revoked })
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
		const lastEventId = c.req.header("Last-Event-ID") || "-1"

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

	// --- SSE Proxy ---

	// Server-side SSE proxy: reads from the hosted durable stream and proxies
	// events to the React client. The client never sees DS credentials.
	app.get("/api/sessions/:id/events", async (c) => {
		const sessionId = c.req.param("id")
		console.log(`[sse] Client connected: session=${sessionId}`)

		// Get the stream connection info (no session lookup needed —
		// the DS stream may exist from a previous server lifetime)
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

	// List GitHub accounts (personal + orgs)
	app.get("/api/github/accounts", (c) => {
		const token = c.req.header("X-GH-Token") || undefined
		try {
			const accounts = ghListAccounts(token)
			return c.json({ accounts })
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : "Failed to list accounts" }, 500)
		}
	})

	// List GitHub repos for the authenticated user
	app.get("/api/github/repos", (c) => {
		const token = c.req.header("X-GH-Token") || undefined
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
		const token = c.req.header("X-GH-Token") || undefined
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

		try {
			const handle = await config.sandbox.createFromRepo(sessionId, body.repoUrl, {
				branch: body.branch,
				apiKey: body.apiKey,
				oauthToken: body.oauthToken,
				ghToken: body.ghToken,
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
			config.sessions.add(session)

			// Write initial message to stream
			const bridge = getOrCreateBridge(config, sessionId)
			await bridge.emit({
				type: "log",
				level: "done",
				message: `Resumed from ${body.repoUrl}`,
				ts: ts(),
			})

			return c.json({ sessionId, session, appPort: handle.port }, 201)
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Failed to resume from repo"
			return c.json({ error: msg }, 500)
		}
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
	inferProjectName?: (description: string) => Promise<string>
}): Promise<void> {
	const config: ServerConfig = {
		port: opts.port ?? 4400,
		dataDir: opts.dataDir ?? path.resolve(process.cwd(), ".electric-agent"),
		sessions: new ActiveSessions(),
		rooms: opts.rooms,
		sandbox: opts.sandbox,
		streamConfig: opts.streamConfig,
		bridgeMode: opts.bridgeMode ?? "stream",
		inferProjectName: opts.inferProjectName,
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
