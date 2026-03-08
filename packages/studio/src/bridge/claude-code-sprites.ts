/**
 * SessionBridge implementation that runs Claude Code CLI inside a Sprites
 * sandbox via the Sprites SDK session API, communicating via stream-json NDJSON.
 *
 * The bridge translates Claude Code's stream-json output into EngineEvents
 * and writes them to the Durable Stream for the UI. User messages and
 * gate responses are sent to Claude Code's stdin.
 *
 * Claude Code runs in one-shot mode (`-p`) and exits after completing.
 * On iterate (follow-up message), the bridge respawns Claude Code with
 * `--resume <sessionId>` so it picks up the previous conversation context.
 */

import * as readline from "node:readline"
import { DurableStream } from "@durable-streams/client"
import type { EngineEvent } from "@electric-agent/protocol"
import { ts } from "@electric-agent/protocol"
import type { Sprite } from "@fly/sprites"
import { SpriteCommand } from "@fly/sprites"
import type { StreamConnectionInfo } from "../streams.js"
import { formatGateMessage } from "./gate-response.js"
import { createStreamJsonParser } from "./stream-json-parser.js"
import type { SessionBridge, StreamMessage } from "./types.js"

export interface ClaudeCodeSpritesConfig {
	/** Initial prompt (the user's app description or task) */
	prompt: string
	/** Working directory inside the sprite */
	cwd: string
	/** Model to use (default: claude-sonnet-4-6) */
	model?: string
	/** Allowed tools (default: all standard tools) */
	allowedTools?: string[]
	/** Additional CLI flags */
	extraFlags?: string[]
	/** Studio server URL — used to set up AskUserQuestion hooks inside the sprite */
	studioUrl?: string
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

export class ClaudeCodeSpritesBridge implements SessionBridge {
	readonly sessionId: string
	readonly streamUrl: string
	readonly streamHeaders: Record<string, string>

	private sprite: Sprite
	private config: ClaudeCodeSpritesConfig
	private writer: DurableStream
	private parser = createStreamJsonParser()
	private agentEventCallbacks: Array<(event: EngineEvent) => void> = []
	private completeCallbacks: Array<(success: boolean) => void> = []
	private closed = false
	private cmd: SpriteCommand | null = null

	/** Claude Code session ID captured from stream-json system.init — used for --resume */
	private claudeSessionId: string | null = null
	/** Whether a Claude Code process is currently running */
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: used in startSession/interrupt/process exit
	private running = false
	/** Whether the parser already emitted a session_end (from a "result" message) */
	private resultReceived = false
	/** Whether the process was intentionally interrupted (suppress exit handler session_end) */
	private interrupted = false
	/** Whether hooks have been installed in the sprite */
	private hooksInstalled = false

	constructor(
		sessionId: string,
		connection: StreamConnectionInfo,
		sprite: Sprite,
		config: ClaudeCodeSpritesConfig,
	) {
		this.sessionId = sessionId
		this.streamUrl = connection.url
		this.streamHeaders = connection.headers
		this.sprite = sprite
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

	async sendCommand(cmd: Record<string, unknown>): Promise<void> {
		if (this.closed) return

		if (cmd.command === "iterate" && typeof cmd.request === "string") {
			// Respawn Claude Code with --resume for follow-up messages
			this.spawnClaudeAsync(cmd.request, this.claudeSessionId ?? undefined)
			return
		}

		console.log(`[claude-code-sprites] Ignoring unsupported command: ${cmd.command}`)
	}

	async sendGateResponse(gate: string, value: Record<string, unknown>): Promise<void> {
		if (this.closed || !this.cmd) return

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
		await this.spawnClaudeAsync(this.config.prompt)
	}

	interrupt(): void {
		this.interrupted = true
		if (this.cmd) {
			try {
				this.cmd.kill()
			} catch {
				// Process may already be dead
			}
			this.cmd = null
		}
		this.running = false
	}

	close(): void {
		this.closed = true
		if (this.cmd) {
			try {
				this.cmd.kill()
			} catch {
				// Process may already be dead
			}
			this.cmd = null
		}
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	/**
	 * Install Claude Code hooks inside the sprite so that AskUserQuestion
	 * blocks until the user answers in the studio UI.
	 */
	private async installHooks(): Promise<void> {
		const studioUrl = this.config.studioUrl
		if (!studioUrl) return

		const hookDir = `${this.config.cwd}/.claude/hooks`
		const settingsFile = `${this.config.cwd}/.claude/settings.local.json`

		const forwardScript = `#!/bin/bash
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
			// Use base64 encoding to avoid heredoc delimiter issues
			const forwardB64 = Buffer.from(forwardScript).toString("base64")
			const settingsB64 = Buffer.from(settings).toString("base64")
			await this.sprite.execFile("bash", [
				"-c",
				[
					`mkdir -p '${hookDir}'`,
					`echo '${forwardB64}' | base64 -d > '${hookDir}/forward.sh'`,
					`chmod +x '${hookDir}/forward.sh'`,
					`echo '${settingsB64}' | base64 -d > '${settingsFile}'`,
				].join(" && "),
			])
			console.log(`[claude-code-sprites] Installed AskUserQuestion hooks in sprite`)
		} catch (err) {
			console.error(`[claude-code-sprites] Failed to install hooks:`, err)
		}
	}

	/**
	 * Spawn a new Claude Code process. Called for both the initial prompt
	 * and follow-up iterate messages (with --resume).
	 */
	private async spawnClaudeAsync(prompt: string, resumeSessionId?: string): Promise<void> {
		// Kill any existing process
		if (this.cmd) {
			try {
				this.cmd.kill()
			} catch {
				// Already dead
			}
			this.cmd = null
		}

		// Install hooks on first spawn (they persist for resume spawns)
		// Must await to ensure hooks are in place before Claude starts.
		if (!this.hooksInstalled) {
			try {
				await this.installHooks()
				this.hooksInstalled = true
			} catch (err) {
				console.error(`[claude-code-sprites] Hook install error:`, err)
			}
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

		// Escape for bash — use bash -c with properly escaped args
		const escapedArgs = claudeArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")
		const fullCmd = `source /etc/profile.d/npm-global.sh 2>/dev/null; source /etc/profile.d/electric-agent.sh 2>/dev/null; cd '${this.config.cwd}' && claude ${escapedArgs}`

		// Use SpriteCommand with tty:true — Claude Code requires a TTY to produce
		// stream-json output in sprites (non-TTY mode results in zero stdout).
		// Do NOT use detachable (creates a tmux session causing immediate exit).
		this.cmd = new SpriteCommand(this.sprite, "bash", ["-c", fullCmd], {
			tty: true,
		})
		this.cmd.start()

		console.log(
			`[claude-code-sprites] Started: session=${this.sessionId} resume=${resumeSessionId ?? "none"}`,
		)

		const currentCmd = this.cmd

		// Read stdout line by line (stream-json NDJSON)
		const rl = readline.createInterface({
			input: currentCmd.stdout,
			terminal: false,
		})

		rl.on("line", (line) => {
			if (this.closed) return
			this.handleLine(line)
		})

		// Log stderr
		const stderrRl = readline.createInterface({
			input: currentCmd.stderr,
			terminal: false,
		})
		stderrRl.on("line", (line) => {
			if (!this.closed) {
				console.error(`[claude-code-sprites:stderr] ${line}`)
			}
		})

		// Handle process exit — defer to let pending readline events flush first,
		// which prevents duplicate session_end (the parser emits one from "result").
		currentCmd.on("exit", (code) => {
			console.log(`[claude-code-sprites] Process exited: code=${code} session=${this.sessionId}`)
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
		// Strip ANSI escape sequences and terminal control chars added by tty mode
		const cleaned = stripAnsi(line).trim()
		if (!cleaned) return

		const events = this.parser.parse(cleaned)
		for (const event of events) {
			this.dispatchEvent(event)
		}
	}

	private dispatchEvent(event: EngineEvent): void {
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

		for (const cb of this.agentEventCallbacks) {
			try {
				cb(event)
			} catch {
				// Swallow callback errors
			}
		}

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

	private writeUserMessage(content: string): void {
		if (!this.cmd) return
		const msg = JSON.stringify({
			type: "user",
			message: { role: "user", content },
		})
		this.cmd.stdin.write(`${msg}\n`)
	}
}

/** Strip ANSI escape sequences and control characters from tty output */
function stripAnsi(str: string): string {
	const ESC = "\x1b"
	const csi = new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, "g")
	const osc1 = new RegExp(`${ESC}\\][^\\x07]*\\x07`, "g")
	const osc2 = new RegExp(`${ESC}\\][^${ESC}]*${ESC}\\\\`, "g")
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip C0 control chars except \n \r
	const ctrl = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g
	return str.replace(csi, "").replace(osc1, "").replace(osc2, "").replace(ctrl, "")
}
