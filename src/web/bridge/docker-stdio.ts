/**
 * SessionBridge implementation that communicates with a Docker container
 * via stdin/stdout NDJSON using `docker exec -i`.
 *
 * The server bridges between the Durable Stream (for UI events) and
 * the container's stdin/stdout (for agent communication).
 */

import { type ChildProcess, spawn } from "node:child_process"
import * as readline from "node:readline"
import { DurableStream } from "@durable-streams/client"
import type { EngineEvent } from "../../engine/events.js"
import type { StreamConnectionInfo } from "../streams.js"
import type { SessionBridge, StreamMessage } from "./types.js"

export class DockerStdioBridge implements SessionBridge {
	readonly sessionId: string
	readonly streamUrl: string
	readonly streamHeaders: Record<string, string>

	private containerId: string
	private writer: DurableStream
	private agentEventCallbacks: Array<(event: EngineEvent) => void> = []
	private completeCallbacks: Array<(success: boolean) => void> = []
	private closed = false
	private proc: ChildProcess | null = null

	constructor(sessionId: string, connection: StreamConnectionInfo, containerId: string) {
		this.sessionId = sessionId
		this.streamUrl = connection.url
		this.streamHeaders = connection.headers
		this.containerId = containerId

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
		if (this.closed || !this.proc?.stdin?.writable) return
		const line = JSON.stringify({ type: "command", ...cmd })
		this.proc.stdin.write(`${line}\n`)
	}

	async sendGateResponse(gate: string, value: Record<string, unknown>): Promise<void> {
		if (this.closed || !this.proc?.stdin?.writable) return
		const line = JSON.stringify({ type: "gate_response", gate, ...value })
		this.proc.stdin.write(`${line}\n`)
	}

	onAgentEvent(cb: (event: EngineEvent) => void): void {
		this.agentEventCallbacks.push(cb)
	}

	onComplete(cb: (success: boolean) => void): void {
		this.completeCallbacks.push(cb)
	}

	async start(): Promise<void> {
		if (this.closed) return

		// Spawn docker exec with stdin piped
		this.proc = spawn("docker", ["exec", "-i", this.containerId, "electric-agent", "headless"], {
			stdio: ["pipe", "pipe", "pipe"],
		})

		console.log(
			`[docker-stdio-bridge] Agent started: session=${this.sessionId} container=${this.containerId} pid=${this.proc.pid}`,
		)

		// Read stdout line by line (NDJSON)
		if (this.proc.stdout) {
			const rl = readline.createInterface({
				input: this.proc.stdout,
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
					console.log(`[docker-stdio-bridge] Non-JSON stdout: ${trimmed}`)
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

				// Detect session_complete
				if (event.type === "session_complete" && "success" in event) {
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
		}

		// Log stderr
		if (this.proc.stderr) {
			const stderrRl = readline.createInterface({
				input: this.proc.stderr,
				terminal: false,
			})
			stderrRl.on("line", (line) => {
				if (!this.closed) {
					console.error(`[docker-stdio-bridge:stderr] ${line}`)
				}
			})
		}

		// Handle process exit
		this.proc.on("exit", (code) => {
			console.log(
				`[docker-stdio-bridge] Agent process exited: code=${code} session=${this.sessionId}`,
			)
		})
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
}
