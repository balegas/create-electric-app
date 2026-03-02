/**
 * SessionBridge implementation that runs Codex CLI inside a Sprites
 * sandbox via the Sprites SDK session API, communicating via exec --json NDJSON.
 *
 * The bridge translates Codex's exec --json output into EngineEvents
 * and writes them to the Durable Stream for the UI.
 *
 * Codex runs in one-shot mode (`codex exec --json`) and exits after completing.
 * On iterate (follow-up message), the bridge respawns Codex with the new prompt.
 */

import * as readline from "node:readline"
import { DurableStream } from "@durable-streams/client"
import type { EngineEvent } from "@electric-agent/protocol"
import { ts } from "@electric-agent/protocol"
import type { Sprite } from "@fly/sprites"
import { SpriteCommand } from "@fly/sprites"
import type { StreamConnectionInfo } from "../streams.js"
import { createCodexJsonParser } from "./codex-json-parser.js"
import type { SessionBridge, StreamMessage } from "./types.js"

export interface CodexSpritesConfig {
	/** Initial prompt (the user's app description or task) */
	prompt: string
	/** Working directory inside the sprite */
	cwd: string
	/** Model to use (default: o4-mini) */
	model?: string
	/** Additional CLI flags */
	extraFlags?: string[]
}

export class CodexSpritesBridge implements SessionBridge {
	readonly sessionId: string
	readonly streamUrl: string
	readonly streamHeaders: Record<string, string>

	private sprite: Sprite
	private config: CodexSpritesConfig
	private writer: DurableStream
	private parser = createCodexJsonParser()
	private agentEventCallbacks: Array<(event: EngineEvent) => void> = []
	private completeCallbacks: Array<(success: boolean) => void> = []
	private closed = false
	private cmd: SpriteCommand | null = null

	/** Codex thread ID captured from thread.started — used for resume */
	private codexThreadId: string | null = null
	/** Whether a Codex process is currently running */
	private running = false
	/** Whether the parser already emitted a session_end */
	private resultReceived = false

	constructor(
		sessionId: string,
		connection: StreamConnectionInfo,
		sprite: Sprite,
		config: CodexSpritesConfig,
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
			this.spawnCodex(cmd.request)
			return
		}

		console.log(`[codex-sprites] Ignoring unsupported command: ${cmd.command}`)
	}

	async sendGateResponse(_gate: string, _value: Record<string, unknown>): Promise<void> {
		// Codex exec --json doesn't support stdin user messages mid-run
	}

	onAgentEvent(cb: (event: EngineEvent) => void): void {
		this.agentEventCallbacks.push(cb)
	}

	onComplete(cb: (success: boolean) => void): void {
		this.completeCallbacks.push(cb)
	}

	async start(): Promise<void> {
		if (this.closed) return
		this.spawnCodex(this.config.prompt)
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
	 * Spawn a new Codex process. Called for both the initial prompt
	 * and follow-up iterate messages.
	 */
	private spawnCodex(prompt: string): void {
		// Kill any existing process
		if (this.cmd) {
			try {
				this.cmd.kill()
			} catch {
				// Already dead
			}
			this.cmd = null
		}

		// Reset parser state for the new process
		this.parser = createCodexJsonParser()
		this.resultReceived = false
		this.running = true

		const model = this.config.model ?? "o4-mini"

		// Build the codex CLI command
		const codexArgs = [
			"exec",
			"--json",
			"--full-auto",
			"--model",
			model,
			...(this.config.extraFlags ?? []),
			"-q",
			prompt,
		]

		// Escape for bash — use bash -c with properly escaped args
		const escapedArgs = codexArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")
		const fullCmd = `source /etc/profile.d/npm-global.sh 2>/dev/null; source /etc/profile.d/electric-agent.sh 2>/dev/null; cd '${this.config.cwd}' && codex ${escapedArgs}`

		// Use SpriteCommand with tty:true (for streaming)
		this.cmd = new SpriteCommand(this.sprite, "bash", ["-c", fullCmd], {
			tty: true,
		})
		this.cmd.start()

		console.log(`[codex-sprites] Started: session=${this.sessionId}`)

		const currentCmd = this.cmd

		// Read stdout line by line (exec --json NDJSON)
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
				console.error(`[codex-sprites:stderr] ${line}`)
			}
		})

		// Handle process exit — defer to let pending readline events flush first
		currentCmd.on("exit", (code) => {
			console.log(`[codex-sprites] Process exited: code=${code} session=${this.sessionId}`)
			setTimeout(() => {
				// Capture thread ID from parser state before marking not running
				if (this.parser.state.threadId) {
					this.codexThreadId = this.parser.state.threadId
				}
				this.running = false

				// Emit session_end if the parser didn't already
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

		// Track session_end to prevent duplicates
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
