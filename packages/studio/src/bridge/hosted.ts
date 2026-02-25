/**
 * SessionBridge implementation backed by the hosted Durable Streams service.
 *
 * Both the web server and the sandbox connect to the same hosted stream.
 * Messages are tagged with `source: "server"` or `source: "agent"`.
 */

import { DurableStream } from "@durable-streams/client"
import type { EngineEvent } from "@electric-agent/protocol"
import { ts } from "@electric-agent/protocol"
import type { StreamConnectionInfo } from "../streams.js"
import type { AgentEvent, SessionBridge, StreamMessage } from "./types.js"

export class HostedStreamBridge implements SessionBridge {
	readonly sessionId: string
	readonly streamUrl: string
	readonly streamHeaders: Record<string, string>

	private writer: DurableStream
	private agentEventCallbacks: Array<(event: EngineEvent) => void> = []
	private completeCallbacks: Array<(success: boolean) => void> = []
	private cancelSubscription: (() => void) | null = null
	private closed = false

	constructor(sessionId: string, connection: StreamConnectionInfo) {
		this.sessionId = sessionId
		this.streamUrl = connection.url
		this.streamHeaders = connection.headers

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
		const msg: StreamMessage = {
			source: "server",
			type: "command",
			ts: ts(),
			...cmd,
		}
		await this.writer.append(JSON.stringify(msg))
	}

	async sendGateResponse(gate: string, value: Record<string, unknown>): Promise<void> {
		if (this.closed) return
		const msg: StreamMessage = {
			source: "server",
			type: "gate_response",
			gate,
			ts: ts(),
			...value,
		}
		await this.writer.append(JSON.stringify(msg))
	}

	onAgentEvent(cb: (event: EngineEvent) => void): void {
		this.agentEventCallbacks.push(cb)
	}

	onComplete(cb: (success: boolean) => void): void {
		this.completeCallbacks.push(cb)
	}

	async start(): Promise<void> {
		if (this.closed) return

		const reader = new DurableStream({
			url: this.streamUrl,
			headers: this.streamHeaders,
			contentType: "application/json",
		})

		const response = await reader.stream<StreamMessage>({
			offset: "-1",
			live: true,
		})

		this.cancelSubscription = response.subscribeJson<StreamMessage>((batch) => {
			for (const item of batch.items) {
				if (item.source !== "agent") continue

				// Strip the source field to get a clean EngineEvent
				const { source: _, ...eventData } = item as AgentEvent
				const event = eventData as unknown as EngineEvent

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
		})
	}

	close(): void {
		this.closed = true
		if (this.cancelSubscription) {
			this.cancelSubscription()
			this.cancelSubscription = null
		}
	}
}
