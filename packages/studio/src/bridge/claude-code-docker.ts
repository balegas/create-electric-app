/**
 * SessionBridge implementation that runs Claude Code CLI inside a Docker
 * container via `docker exec -i`, communicating via stream-json NDJSON.
 *
 * The bridge translates Claude Code's stream-json output into EngineEvents
 * and writes them to the Durable Stream for the UI. User messages and
 * gate responses are sent to Claude Code's stdin.
 *
 * Claude Code runs in one-shot mode (`-p`) and exits after completing.
 * On iterate (follow-up message), the bridge respawns Claude Code with
 * `--resume <sessionId>` so it picks up the previous conversation context.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import * as readline from "node:readline"
import { DurableStream } from "@durable-streams/client"
import type { EngineEvent } from "@electric-agent/protocol"
import { ts } from "@electric-agent/protocol"
import type { StreamConnectionInfo } from "../streams.js"
import { formatGateMessage } from "./gate-response.js"
import { createStreamJsonParser } from "./stream-json-parser.js"
import type { SessionBridge, StreamMessage } from "./types.js"

export interface ClaudeCodeDockerConfig {
	/** Initial prompt (the user's app description or task) */
	prompt: string
	/** Working directory inside the container */
	cwd: string
	/** Model to use (default: claude-sonnet-4-6) */
	model?: string
	/** Allowed tools (default: all standard tools) */
	allowedTools?: string[]
	/** Additional CLI flags */
	extraFlags?: string[]
	/** Studio server port — used to set up AskUserQuestion hooks inside the container */
	studioPort?: number
}

const DEFAULT_ALLOWED_TOOLS = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Glob",
	"Grep",
	"WebSearch",
	"TodoWrite",
	"AskUserQuestion",
	"Skill",
]

export class ClaudeCodeDockerBridge implements SessionBridge {
	readonly sessionId: string
	readonly streamUrl: string
	readonly streamHeaders: Record<string, string>

	private containerId: string
	private config: ClaudeCodeDockerConfig
	private writer: DurableStream
	private parser = createStreamJsonParser()
	private agentEventCallbacks: Array<(event: EngineEvent) => void> = []
	private completeCallbacks: Array<(success: boolean) => void> = []
	private closed = false
	private proc: ChildProcess | null = null

	/** Claude Code session ID captured from stream-json system.init — used for --resume */
	private claudeSessionId: string | null = null
	/** Whether a Claude Code process is currently running */
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: used in startSession/interrupt/process exit
	private running = false
	/** Whether the parser already emitted a session_end (from a "result" message) */
	private resultReceived = false
	/** Whether the process was intentionally interrupted (suppress exit handler session_end) */
	private interrupted = false
	/** Whether hooks have been installed in the container */
	private hooksInstalled = false

	constructor(
		sessionId: string,
		connection: StreamConnectionInfo,
		containerId: string,
		config: ClaudeCodeDockerConfig,
	) {
		this.sessionId = sessionId
		this.streamUrl = connection.url
		this.streamHeaders = connection.headers
		this.containerId = containerId
		this.config = config

		this.writer = new DurableStream({
			url: connection.url,
			headers: connection.headers,
			contentType: "application/json",
		})
	}

	async emit(event: EngineEvent): Promise<void> {
		if (this.closed) return
		const msg: StreamMessage = { source: "server", ...event }
		await this.writer.append(JSON.stringify(msg))
	}

	/**
	 * Send a follow-up user message to Claude Code by respawning with --resume.
	 * Used for iteration requests (the user types a new message in the UI).
	 */
	async sendCommand(cmd: Record<string, unknown>): Promise<void> {
		if (this.closed) return

		// For iteration: respawn Claude Code with --resume
		if (cmd.command === "iterate" && typeof cmd.request === "string") {
			this.spawnClaude(cmd.request, this.claudeSessionId ?? undefined)
			return
		}

		// For initial "new" command: this is handled in start() via the prompt
		// Other commands are ignored — Claude Code doesn't understand them
		console.log(`[claude-code-docker] Ignoring unsupported command: ${cmd.command}`)
	}

	/**
	 * Send a gate response back to Claude Code as a user message.
	 * For ask_user_question gates, the user's answer becomes a follow-up message.
	 */
	async sendGateResponse(gate: string, value: Record<string, unknown>): Promise<void> {
		if (this.closed || !this.proc?.stdin?.writable) return

		const message = formatGateMessage(gate, value)
		if (message != null) {
			this.writeUserMessage(message)
		}
	}

	onAgentEvent(cb: (event: EngineEvent) => void): void {
		this.agentEventCallbacks.push(cb)
	}

	onComplete(cb: (success: boolean) => void): void {
		this.completeCallbacks.push(cb)
	}

	async start(): Promise<void> {
		if (this.closed) return
		this.spawnClaude(this.config.prompt)
	}

	interrupt(): void {
		this.interrupted = true
		if (this.proc) {
			try {
				this.proc.stdin?.end()
				this.proc.kill("SIGTERM")
			} catch {
				// Process may already be dead
			}
			this.proc = null
		}
		this.running = false
	}

	close(): void {
		this.closed = true
		if (this.proc) {
			try {
				this.proc.stdin?.end()
				this.proc.kill("SIGTERM")
			} catch {
				// Process may already be dead
			}
			this.proc = null
		}
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	/**
	 * Install Claude Code hooks inside the container so that AskUserQuestion
	 * blocks until the user answers in the studio UI.
	 * The hook script forwards the PreToolUse event to the studio server via HTTP,
	 * which blocks the response until the gate is resolved.
	 */
	private installHooks(): void {
		const port = this.config.studioPort
		if (!port) return

		const hookDir = `${this.config.cwd}/.claude/hooks`
		const settingsFile = `${this.config.cwd}/.claude/settings.local.json`
		// Studio server is on the host — use host.docker.internal to reach it
		const studioUrl = `http://host.docker.internal:${port}`

		const forwardScript = `#!/bin/bash
# Forward AskUserQuestion hook events to Electric Agent studio.
# Blocks until the user answers in the web UI.
BODY="$(cat)"
RESPONSE=$(curl -s -X POST "${studioUrl}/api/sessions/${this.sessionId}/hook-event" \\
  -H "Content-Type: application/json" \\
  -d "\${BODY}" \\
  --max-time 360 \\
  --connect-timeout 5 \\
  2>/dev/null)
if echo "\${RESPONSE}" | grep -q '"hookSpecificOutput"'; then
  echo "\${RESPONSE}"
fi
exit 0`

		// Configure hooks in settings.local.json.
		// Tool permissions come from --allowedTools CLI flag instead.
		// Hook format: each event has matcher groups, each with a `hooks` array.
		const settings = JSON.stringify({
			hooks: {
				PreToolUse: [
					{
						matcher: "AskUserQuestion",
						hooks: [
							{
								type: "command",
								command: `${hookDir}/forward.sh`,
							},
						],
					},
				],
			},
		})

		try {
			// Use base64 encoding to avoid heredoc delimiter issues in docker exec
			const forwardB64 = Buffer.from(forwardScript).toString("base64")
			const settingsB64 = Buffer.from(settings).toString("base64")
			const setupCmd = [
				`mkdir -p '${hookDir}'`,
				`echo '${forwardB64}' | base64 -d > '${hookDir}/forward.sh'`,
				`chmod +x '${hookDir}/forward.sh'`,
				`echo '${settingsB64}' | base64 -d > '${settingsFile}'`,
			].join(" && ")

			execFileSync("docker", ["exec", this.containerId, "bash", "-c", setupCmd], {
				timeout: 10_000,
				stdio: ["ignore", "pipe", "pipe"],
			})
			console.log(`[claude-code-docker] Installed AskUserQuestion hooks in container`)
		} catch (err) {
			console.error(`[claude-code-docker] Failed to install hooks:`, err)
		}
	}

	/**
	 * Spawn a new Claude Code process. Called for both the initial prompt
	 * and follow-up iterate messages (with --resume).
	 */
	private spawnClaude(prompt: string, resumeSessionId?: string): void {
		// Kill any existing process
		if (this.proc) {
			try {
				this.proc.stdin?.end()
				this.proc.kill("SIGTERM")
			} catch {
				// Already dead
			}
			this.proc = null
		}

		// Install hooks on first spawn (they persist for resume spawns)
		if (!this.hooksInstalled) {
			this.installHooks()
			this.hooksInstalled = true
		}

		// Reset parser state for the new process
		this.parser = createStreamJsonParser()
		this.resultReceived = false
		this.interrupted = false
		this.running = true

		const model = this.config.model ?? "claude-sonnet-4-6"

		// Build the claude CLI command.
		// Use --allowedTools to grant permissions (keeps hooks firing, unlike
		// --dangerously-skip-permissions which bypasses hooks entirely).
		// Use --settings to pass hook configuration directly (more reliable
		// than settings.local.json which may not be loaded by all versions).
		const allowedTools = this.config.allowedTools ?? DEFAULT_ALLOWED_TOOLS
		const claudeArgs = [
			"-p",
			prompt,
			"--output-format",
			"stream-json",
			"--verbose",
			"--model",
			model,
			...(this.hooksInstalled
				? ["--allowedTools", allowedTools.join(",")]
				: ["--dangerously-skip-permissions"]),
			...(this.config.extraFlags ?? []),
		]

		// Add --resume if we have a previous session ID
		if (resumeSessionId) {
			claudeArgs.push("--resume", resumeSessionId)
		}

		// Escape for bash
		const escapedArgs = claudeArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")
		const cmd = `cd '${this.config.cwd}' && claude ${escapedArgs}`

		// Note: do NOT use -i flag — Claude Code detects interactive stdin and blocks
		// waiting for input even when -p is provided. Without -i, stdout flows normally.
		this.proc = spawn("docker", ["exec", this.containerId, "bash", "-c", cmd], {
			stdio: ["pipe", "pipe", "pipe"],
		})

		console.log(
			`[claude-code-docker] Started: session=${this.sessionId} container=${this.containerId} pid=${this.proc.pid} resume=${resumeSessionId ?? "none"}`,
		)
		console.log(`[claude-code-docker] cmd: ${cmd}`)

		const currentProc = this.proc

		// Read stdout line by line (stream-json NDJSON)
		if (currentProc.stdout) {
			const rl = readline.createInterface({
				input: currentProc.stdout,
				terminal: false,
			})

			rl.on("line", (line) => {
				if (this.closed) return
				console.log(`[claude-code-docker:stdout] ${line.slice(0, 120)}...`)
				this.handleLine(line)
			})
		}

		// Log stderr
		if (currentProc.stderr) {
			const stderrRl = readline.createInterface({
				input: currentProc.stderr,
				terminal: false,
			})
			stderrRl.on("line", (line) => {
				if (!this.closed) {
					console.error(`[claude-code-docker:stderr] ${line}`)
				}
			})
		}

		// Handle process exit — defer to let pending readline events flush first,
		// which prevents duplicate session_end (the parser emits one from "result").
		currentProc.on("exit", (code) => {
			console.log(`[claude-code-docker] Process exited: code=${code} session=${this.sessionId}`)
			setTimeout(() => {
				// Capture session ID from parser state before marking not running
				if (this.parser.state.sessionId) {
					this.claudeSessionId = this.parser.state.sessionId
				}
				this.running = false

				// Only emit session_end from exit handler if the parser didn't already
				// emit one (via a "result" message) and the process wasn't intentionally
				// interrupted. This prevents double session_end.
				if (!this.closed && !this.resultReceived && !this.interrupted) {
					const endEvent: EngineEvent = {
						type: "session_end",
						success: code === 0,
						ts: ts(),
					}
					this.dispatchEvent(endEvent)
				}
			}, 100)
		})
	}

	private handleLine(line: string): void {
		const trimmed = line.trim()
		if (!trimmed) return

		const events = this.parser.parse(trimmed)
		for (const event of events) {
			this.dispatchEvent(event)
		}
	}

	private dispatchEvent(event: EngineEvent): void {
		// Write to Durable Stream for UI
		const msg: StreamMessage = { source: "agent", ...event }
		this.writer.append(JSON.stringify(msg)).catch(() => {})

		// Track session_end from result messages to prevent duplicates
		if (event.type === "session_end") {
			this.resultReceived = true
		}

		// Detect dev:start in Bash tool_use → emit app_status for the UI preview
		if (event.type === "pre_tool_use" && event.tool_name === "Bash") {
			const cmd = (event.tool_input as Record<string, unknown>)?.command
			if (typeof cmd === "string" && /\bdev:start\b/.test(cmd)) {
				const appStatus: EngineEvent = {
					type: "app_status",
					status: "running",
					ts: ts(),
				}
				const appStatusMsg: StreamMessage = { source: "agent", ...appStatus }
				this.writer.append(JSON.stringify(appStatusMsg)).catch(() => {})
				for (const cb of this.agentEventCallbacks) {
					try {
						cb(appStatus)
					} catch {
						// Swallow
					}
				}
			}
		}

		// Dispatch to callbacks
		for (const cb of this.agentEventCallbacks) {
			try {
				cb(event)
			} catch {
				// Swallow callback errors
			}
		}

		// Detect session_end
		if (event.type === "session_end" && "success" in event) {
			const success = (event as EngineEvent & { success: boolean }).success
			for (const cb of this.completeCallbacks) {
				try {
					cb(success)
				} catch {
					// Swallow callback errors
				}
			}
		}
	}

	/**
	 * Write a user message to Claude Code's stdin in stream-json format.
	 */
	private writeUserMessage(content: string): void {
		if (!this.proc?.stdin?.writable) return
		const msg = JSON.stringify({
			type: "user",
			message: { role: "user", content },
		})
		this.proc.stdin.write(`${msg}\n`)
	}
}
