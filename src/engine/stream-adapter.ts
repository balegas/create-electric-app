/**
 * Headless adapter that communicates via a hosted Durable Stream
 * instead of stdin/stdout.
 *
 * The agent reads server messages (commands, gate responses) from the
 * stream and writes agent events back, all tagged with a `source` field.
 *
 * Environment variables:
 *   DS_STREAM_URL — full stream endpoint URL
 *   DS_SECRET     — Bearer token for auth
 */

import { DurableStream } from "@durable-streams/client"
import type { EngineEvent } from "./events.js"
import type { OrchestratorCallbacks } from "./orchestrator.js"

export interface HeadlessConfig {
	command: "new" | "iterate" | "git"
	description?: string
	projectName?: string
	baseDir?: string
	projectDir?: string
	request?: string
	resumeSessionId?: string
	initGit?: boolean
	gitOp?: "commit" | "push" | "create-repo" | "create-pr"
	gitMessage?: string
	gitRepoName?: string
	gitRepoVisibility?: "public" | "private"
	gitPrTitle?: string
	gitPrBody?: string
}

interface StreamMessage {
	source: "server" | "agent"
	type?: string
	[key: string]: unknown
}

/**
 * Create a headless adapter that communicates via a hosted Durable Stream.
 *
 * Stream protocol:
 *   Server → Agent: { source: "server", type: "command", command: "new", ... }
 *                    { source: "server", type: "gate_response", gate: "approval", ... }
 *   Agent → Server: { source: "agent", type: "tool_start", ... }
 *                    { source: "agent", type: "session_complete", ... }
 */
export function createStreamAdapter(streamUrl: string, secret: string) {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${secret}`,
	}

	const writer = new DurableStream({
		url: streamUrl,
		headers,
		contentType: "application/json",
	})

	// Pending gate response resolvers
	const pendingGates = new Map<string, { resolve: (value: unknown) => void }>()
	// Buffered commands
	const commandQueue: StreamMessage[] = []
	let commandResolve: ((msg: StreamMessage) => void) | null = null

	// Config promise
	let configResolve: ((config: HeadlessConfig) => void) | null = null
	let gotConfig = false
	let closed = false

	// Subscribe to the stream to receive server messages
	let cancelSubscription: (() => void) | null = null

	async function startListening(): Promise<void> {
		const reader = new DurableStream({
			url: streamUrl,
			headers,
			contentType: "application/json",
		})

		const response = await reader.stream<StreamMessage>({
			offset: "-1",
			live: true,
		})

		cancelSubscription = response.subscribeJson<StreamMessage>((batch) => {
			for (const item of batch.items) {
				if (item.source !== "server") continue

				if (item.type === "command" && !gotConfig) {
					// First command is the initial config
					gotConfig = true
					const { source: _, type: _t, ...rest } = item
					configResolve?.(rest as unknown as HeadlessConfig)
					continue
				}

				if (item.type === "command") {
					const { source: _, type: _t, ...rest } = item
					if (commandResolve) {
						const resolve = commandResolve
						commandResolve = null
						resolve(rest as StreamMessage)
					} else {
						commandQueue.push(rest as StreamMessage)
					}
					continue
				}

				if (item.type === "gate_response") {
					const gate = item.gate as string
					if (!gate) continue
					const entry = pendingGates.get(gate)
					if (entry) {
						pendingGates.delete(gate)
						entry.resolve(item)
					}
				}
			}
		})
	}

	async function writeEvent(event: EngineEvent): Promise<void> {
		if (closed) return
		const msg: StreamMessage = { source: "agent", ...event }
		await writer.append(JSON.stringify(msg))
	}

	function waitForGate<T>(gateName: string): Promise<T> {
		return new Promise<T>((resolve) => {
			pendingGates.set(gateName, {
				resolve: resolve as (value: unknown) => void,
			})
		})
	}

	function readConfig(): Promise<HeadlessConfig> {
		if (gotConfig) {
			return Promise.reject(new Error("Config already read"))
		}
		return new Promise<HeadlessConfig>((resolve) => {
			configResolve = resolve
		})
	}

	function waitForCommand(): Promise<HeadlessConfig> {
		if (commandQueue.length > 0) {
			return Promise.resolve(commandQueue.shift() as unknown as HeadlessConfig)
		}
		return new Promise<HeadlessConfig>((resolve) => {
			commandResolve = (msg: StreamMessage) => resolve(msg as unknown as HeadlessConfig)
		})
	}

	const callbacks: OrchestratorCallbacks = {
		onEvent(event: EngineEvent) {
			// Fire-and-forget write to stream
			writeEvent(event).catch(() => {})
		},

		async onClarificationNeeded(_questions, _summary) {
			const response = await waitForGate<{ answers: string[] }>("clarification")
			return response.answers
		},

		async onPlanReady(_plan) {
			const response = await waitForGate<{
				decision: "approve" | "revise" | "cancel"
			}>("approval")
			return response.decision
		},

		async onRevisionRequested() {
			const response = await waitForGate<{ feedback: string }>("revision")
			return response.feedback
		},

		async onContinueNeeded() {
			const response = await waitForGate<{ proceed: boolean }>("continue")
			return response.proceed
		},
	}

	function close(): void {
		closed = true
		if (cancelSubscription) {
			cancelSubscription()
			cancelSubscription = null
		}
	}

	return {
		startListening,
		readConfig,
		waitForCommand,
		callbacks,
		close,
	}
}
