/**
 * SessionBridge implementation that communicates with a Sprites sandbox
 * via the Sprites SDK session API (stdin/stdout NDJSON).
 *
 * The server bridges between the Durable Stream (for UI events) and
 * the Sprites session (for agent communication). The agent inside the
 * sprite uses the stdio adapter — the bridge relays events to the stream.
 */

import * as readline from "node:readline"
import { DurableStream } from "@durable-streams/client"
import type { EngineEvent } from "@electric-agent/protocol"
import type { Sprite, SpriteCommand } from "@fly/sprites"
import type { StreamConnectionInfo } from "../streams.js"
import type { SessionBridge, StreamMessage } from "./types.js"

const SPRITES_SESSION_ID = "agent-session"

export class SpritesStdioBridge implements SessionBridge {
	readonly sessionId: string
	readonly streamUrl: string
	readonly streamHeaders: Record<string, string>

	private sprite: Sprite
	private writer: DurableStream
	private agentEventCallbacks: Array<(event: EngineEvent) => void> = []
	private completeCallbacks: Array<(success: boolean) => void> = []
	private closed = false
	private cmd: SpriteCommand | null = null

	constructor(sessionId: string, connection: StreamConnectionInfo, sprite: Sprite) {
		this.sessionId = sessionId
		this.streamUrl = connection.url
		this.streamHeaders = connection.headers
		this.sprite = sprite

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
		const line = JSON.stringify({ type: "command", ...cmd })
		this.cmd.stdin.write(`${line}\n`)
	}

	async sendGateResponse(gate: string, value: Record<string, unknown>): Promise<void> {
		if (this.closed || !this.cmd) return
		const line = JSON.stringify({ type: "gate_response", gate, ...value })
		this.cmd.stdin.write(`${line}\n`)
	}

	onAgentEvent(cb: (event: EngineEvent) => void): void {
		this.agentEventCallbacks.push(cb)
	}

	onComplete(cb: (success: boolean) => void): void {
		this.completeCallbacks.push(cb)
	}

	async start(): Promise<void> {
		if (this.closed) return

		// Create a persistent session in the sprite so we can reconnect if needed
		this.cmd = this.sprite.createSession(
			"bash",
			[
				"-c",
				"source /etc/profile.d/npm-global.sh 2>/dev/null; source /etc/profile.d/electric-agent.sh && electric-agent headless",
			],
			{ detachable: true, sessionId: SPRITES_SESSION_ID },
		)

		console.log(`[sprites-bridge] Agent started: session=${this.sessionId}`)

		// Read stdout line by line (NDJSON)
		const rl = readline.createInterface({
			input: this.cmd.stdout,
			terminal: false,
		})

		rl.on("line", (line) => {
			if (this.closed) return
			const trimmed = line.trim()
			if (!trimmed) return

			let event: EngineEvent
			try {
				event = JSON.parse(trimmed) as EngineEvent
			} catch {
				console.log(`[sprites-bridge] Non-JSON stdout: ${trimmed}`)
				return
			}

			// Write to Durable Stream for UI
			const msg: StreamMessage = { source: "agent", ...event }
			this.writer.append(JSON.stringify(msg)).catch(() => {})

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
		})

		// Log stderr
		const stderrRl = readline.createInterface({
			input: this.cmd.stderr,
			terminal: false,
		})
		stderrRl.on("line", (line) => {
			if (!this.closed) {
				console.error(`[sprites-bridge:stderr] ${line}`)
			}
		})

		// Handle process exit
		this.cmd.on("exit", (code) => {
			console.log(`[sprites-bridge] Agent process exited: code=${code} session=${this.sessionId}`)
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
}
