/**
 * Headless adapter that communicates via stdin/stdout NDJSON.
 *
 * Each line is a JSON object terminated by `\n`.
 *
 * Server → Agent (stdin):
 *   { type: "command", command: "new", description: "...", ... }
 *   { type: "gate_response", gate: "approval", decision: "approve" }
 *
 * Agent → Server (stdout):
 *   { type: "log", level: "task", message: "...", ts: "..." }
 *   { type: "session_end", success: true, ts: "..." }
 *
 * Stderr is used for non-protocol diagnostics only.
 */

import * as readline from "node:readline"
import type { EngineEvent } from "./events.js"
import type { OrchestratorCallbacks } from "./orchestrator.js"
import type { HeadlessConfig } from "./stream-adapter.js"

export function createStdioAdapter() {
	// Pending gate response resolvers
	const pendingGates = new Map<string, { resolve: (value: unknown) => void }>()
	// Buffered commands
	const commandQueue: Record<string, unknown>[] = []
	let commandResolve: ((msg: Record<string, unknown>) => void) | null = null

	// Config promise
	let configResolve: ((config: HeadlessConfig) => void) | null = null
	let gotConfig = false
	let closed = false

	const rl = readline.createInterface({
		input: process.stdin,
		terminal: false,
	})

	rl.on("line", (line) => {
		if (closed) return
		const trimmed = line.trim()
		if (!trimmed) return

		let msg: Record<string, unknown>
		try {
			msg = JSON.parse(trimmed) as Record<string, unknown>
		} catch {
			process.stderr.write(`[stdio-adapter] Invalid JSON: ${trimmed}\n`)
			return
		}

		const type = msg.type as string | undefined

		if (type === "command" && !gotConfig) {
			// First command is the initial config
			gotConfig = true
			const { type: _, ...rest } = msg
			configResolve?.(rest as unknown as HeadlessConfig)
			return
		}

		if (type === "command") {
			const { type: _, ...rest } = msg
			if (commandResolve) {
				const resolve = commandResolve
				commandResolve = null
				resolve(rest)
			} else {
				commandQueue.push(rest)
			}
			return
		}

		if (type === "gate_response") {
			const gate = msg.gate as string
			if (!gate) return
			const entry = pendingGates.get(gate)
			if (entry) {
				pendingGates.delete(gate)
				entry.resolve(msg)
			}
		}
	})

	rl.on("close", () => {
		closed = true
	})

	function writeEvent(event: EngineEvent): void {
		if (closed) return
		process.stdout.write(`${JSON.stringify(event)}\n`)
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
			commandResolve = (msg: Record<string, unknown>) => resolve(msg as unknown as HeadlessConfig)
		})
	}

	const callbacks: OrchestratorCallbacks = {
		onEvent(event: EngineEvent) {
			writeEvent(event)
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
		rl.close()
	}

	return {
		readConfig,
		waitForCommand,
		callbacks,
		close,
	}
}
