/**
 * SessionBridge implementation that communicates with a Daytona sandbox
 * via the Daytona SDK session API (stdin/stdout NDJSON).
 *
 * The server bridges between the Durable Stream (for UI events) and
 * the Daytona session (for agent communication). The agent inside the
 * sandbox uses the stdio adapter — no outbound internet required.
 */

import type { Sandbox } from "@daytonaio/sdk"
import { DurableStream } from "@durable-streams/client"
import type { EngineEvent } from "../../engine/events.js"
import type { StreamConnectionInfo } from "../streams.js"
import type { SessionBridge, StreamMessage } from "./types.js"

const DAYTONA_SESSION_ID = "agent-session"

export class DaytonaSessionBridge implements SessionBridge {
	readonly sessionId: string
	readonly streamUrl: string
	readonly streamHeaders: Record<string, string>

	private sandbox: Sandbox
	private writer: DurableStream
	private agentEventCallbacks: Array<(event: EngineEvent) => void> = []
	private completeCallbacks: Array<(success: boolean) => void> = []
	private closed = false
	private cmdId: string | null = null
	private stdoutBuffer = ""

	constructor(sessionId: string, connection: StreamConnectionInfo, sandbox: Sandbox) {
		this.sessionId = sessionId
		this.streamUrl = connection.url
		this.streamHeaders = connection.headers
		this.sandbox = sandbox

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
		if (this.closed || !this.cmdId) return
		const line = JSON.stringify({ type: "command", ...cmd })
		await this.sandbox.process.sendSessionCommandInput(DAYTONA_SESSION_ID, this.cmdId, `${line}\n`)
	}

	async sendGateResponse(gate: string, value: Record<string, unknown>): Promise<void> {
		if (this.closed || !this.cmdId) return
		const line = JSON.stringify({ type: "gate_response", gate, ...value })
		await this.sandbox.process.sendSessionCommandInput(DAYTONA_SESSION_ID, this.cmdId, `${line}\n`)
	}

	onAgentEvent(cb: (event: EngineEvent) => void): void {
		this.agentEventCallbacks.push(cb)
	}

	onComplete(cb: (success: boolean) => void): void {
		this.completeCallbacks.push(cb)
	}

	async start(): Promise<void> {
		if (this.closed) return

		// Create a persistent session in the sandbox
		await this.sandbox.process.createSession(DAYTONA_SESSION_ID)

		// Start the headless agent asynchronously
		const response = await this.sandbox.process.executeSessionCommand(DAYTONA_SESSION_ID, {
			command: "electric-agent headless",
			runAsync: true,
		})

		this.cmdId = response.cmdId ?? null
		if (!this.cmdId) {
			throw new Error("Failed to get command ID from Daytona session")
		}

		console.log(`[daytona-bridge] Agent started: session=${this.sessionId} cmdId=${this.cmdId}`)

		// Stream stdout output via log polling
		this.pollLogs().catch((err) => {
			if (!this.closed) {
				console.error(`[daytona-bridge] Log streaming error:`, err)
			}
		})
	}

	private async pollLogs(): Promise<void> {
		if (!this.cmdId) return

		try {
			await this.sandbox.process.getSessionCommandLogs(
				DAYTONA_SESSION_ID,
				this.cmdId,
				(chunk: string) => this.handleStdout(chunk),
				(chunk: string) => {
					if (!this.closed) {
						process.stderr.write(`[daytona-bridge:stderr] ${chunk}`)
					}
				},
			)
		} catch (err) {
			if (!this.closed) {
				console.error(`[daytona-bridge] getSessionCommandLogs error:`, err)
			}
		}
	}

	private handleStdout(chunk: string): void {
		if (this.closed) return

		// Buffer partial lines
		this.stdoutBuffer += chunk
		const lines = this.stdoutBuffer.split("\n")
		// Keep the last (possibly incomplete) line in the buffer
		this.stdoutBuffer = lines.pop() ?? ""

		for (const line of lines) {
			const trimmed = line.trim()
			if (!trimmed) continue

			let event: EngineEvent
			try {
				event = JSON.parse(trimmed) as EngineEvent
			} catch {
				// Not valid JSON — log as diagnostic
				console.log(`[daytona-bridge] Non-JSON stdout: ${trimmed}`)
				continue
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
		}
	}

	close(): void {
		this.closed = true
	}
}
