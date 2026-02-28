/**
 * SessionBridge implementation that runs Claude Code CLI inside a Sprites
 * sandbox via the Sprites SDK session API, communicating via stream-json NDJSON.
 *
 * The bridge translates Claude Code's stream-json output into EngineEvents
 * and writes them to the Durable Stream for the UI. User messages and
 * gate responses are sent to Claude Code's stdin.
 */

import * as readline from "node:readline"
import { DurableStream } from "@durable-streams/client"
import type { EngineEvent } from "@electric-agent/protocol"
import { ts } from "@electric-agent/protocol"
import type { Sprite, SpriteCommand } from "@fly/sprites"
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
		if (this.closed || !this.cmd) return

		if (cmd.command === "iterate" && typeof cmd.request === "string") {
			this.writeUserMessage(cmd.request)
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

		const allowedTools = this.config.allowedTools ?? DEFAULT_ALLOWED_TOOLS
		const model = this.config.model ?? "claude-sonnet-4-6"

		// Build the claude CLI command
		const claudeArgs = [
			"-p",
			this.config.prompt,
			"--output-format",
			"stream-json",
			"--verbose",
			"--model",
			model,
			"--dangerously-skip-permissions",
			"--allowedTools",
			allowedTools.join(","),
			...(this.config.extraFlags ?? []),
		]

		// Escape for bash — use bash -c with properly escaped args
		const escapedArgs = claudeArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")
		const fullCmd = `source /etc/profile.d/npm-global.sh 2>/dev/null; source /etc/profile.d/electric-agent.sh 2>/dev/null; cd '${this.config.cwd}' && claude ${escapedArgs}`

		this.cmd = this.sprite.createSession("bash", ["-c", fullCmd], {
			detachable: true,
			sessionId: SPRITES_SESSION_ID,
		})

		console.log(`[claude-code-sprites] Started: session=${this.sessionId}`)

		// Read stdout line by line (stream-json NDJSON)
		const rl = readline.createInterface({
			input: this.cmd.stdout,
			terminal: false,
		})

		rl.on("line", (line) => {
			if (this.closed) return
			this.handleLine(line)
		})

		// Log stderr
		const stderrRl = readline.createInterface({
			input: this.cmd.stderr,
			terminal: false,
		})
		stderrRl.on("line", (line) => {
			if (!this.closed) {
				console.error(`[claude-code-sprites:stderr] ${line}`)
			}
		})

		// Handle process exit
		this.cmd.on("exit", (code) => {
			console.log(`[claude-code-sprites] Process exited: code=${code} session=${this.sessionId}`)
			if (!this.closed) {
				const endEvent: EngineEvent = {
					type: "session_end",
					success: code === 0,
					ts: ts(),
				}
				this.dispatchEvent(endEvent)
			}
		})
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
