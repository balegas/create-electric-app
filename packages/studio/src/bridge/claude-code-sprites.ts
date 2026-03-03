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
import { createStreamJsonParser } from "./stream-json-parser.js"
import type { SessionBridge, StreamMessage } from "./types.js"

const SPRITES_SESSION_ID = "claude-code-session"

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
	private running = false
	/** Whether the parser already emitted a session_end (from a "result" message) */
	private resultReceived = false
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

		if (gate === "ask_user_question" || gate.startsWith("ask_user_question:")) {
			const answer = (value.answer as string) || ""
			this.writeUserMessage(answer)
			return
		}

		if (gate === "clarification") {
			const answers = value.answers as string[] | undefined
			if (answers?.length) {
				this.writeUserMessage(answers.join("\n"))
			}
			return
		}

		if (gate === "approval") {
			const decision = (value.decision as string) || "approve"
			this.writeUserMessage(decision)
			return
		}

		if (gate === "continue") {
			const proceed = value.proceed as boolean
			this.writeUserMessage(proceed ? "continue" : "stop")
			return
		}

		this.writeUserMessage(JSON.stringify(value))
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

		// Use SpriteCommand with tty:false so stdout/stderr are cleanly
		// separated via binary WebSocket stream IDs. tty:true merges them
		// through a PTY which corrupts hook response JSON and prevents
		// AskUserQuestion gates from blocking properly.
		// Do NOT use detachable (creates a tmux session causing immediate exit).
		this.cmd = new SpriteCommand(this.sprite, "bash", ["-c", fullCmd])
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
				// emit one (via a "result" message). This prevents double session_end.
				if (!this.closed && !this.resultReceived) {
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
		const msg: StreamMessage = { source: "agent", ...event }
		this.writer.append(JSON.stringify(msg)).catch(() => {})

		// Track session_end from result messages to prevent duplicates
		if (event.type === "session_end") {
			this.resultReceived = true
		}

		// Detect dev:start in Bash tool_use → emit app_ready for the UI preview
		if (event.type === "pre_tool_use" && event.tool_name === "Bash") {
			const cmd = (event.tool_input as Record<string, unknown>)?.command
			if (typeof cmd === "string" && /\bdev:start\b/.test(cmd)) {
				const appReady: EngineEvent = { type: "app_ready", ts: ts() }
				const appReadyMsg: StreamMessage = { source: "agent", ...appReady }
				this.writer.append(JSON.stringify(appReadyMsg)).catch(() => {})
				for (const cb of this.agentEventCallbacks) {
					try {
						cb(appReady)
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
