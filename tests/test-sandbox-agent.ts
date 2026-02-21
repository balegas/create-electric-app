/**
 * Minimal test agent for integration testing.
 *
 * Supports two modes:
 *   --stdio:  reads NDJSON from stdin, writes events to stdout
 *   --stream: reads commands from a hosted Durable Stream, writes events back
 *
 * The agent echoes back received commands as events (prefixed with "echo_")
 * and emits session_complete when done. This validates the full
 * communication pipeline without running actual Claude agents.
 */

import readline from "node:readline"

const mode = process.argv.includes("--stream") ? "stream" : "stdio"

interface Message {
	source?: string
	type?: string
	command?: string
	gate?: string
	[key: string]: unknown
}

function ts(): string {
	return new Date().toISOString()
}

// ---------------------------------------------------------------------------
// Stdio mode
// ---------------------------------------------------------------------------

async function runStdio(): Promise<void> {
	const rl = readline.createInterface({ input: process.stdin, terminal: false })
	let gotConfig = false

	function emit(event: Record<string, unknown>): void {
		process.stdout.write(`${JSON.stringify(event)}\n`)
	}

	rl.on("line", (line) => {
		const trimmed = line.trim()
		if (!trimmed) return

		try {
			const msg = JSON.parse(trimmed) as Message

			if (!gotConfig) {
				gotConfig = true
				emit({
					type: "log",
					level: "done",
					message: `Test agent received config: command=${msg.command}`,
					ts: ts(),
				})
				emit({
					type: "echo_config",
					...msg,
					ts: ts(),
				})
				emit({ type: "session_complete", success: true, ts: ts() })
				return
			}

			// Gate response
			if (msg.gate) {
				emit({
					type: "echo_gate_response",
					gate: msg.gate,
					...msg,
					ts: ts(),
				})
				return
			}

			// Subsequent command
			if (msg.command) {
				emit({
					type: "echo_command",
					...msg,
					ts: ts(),
				})
				emit({ type: "session_complete", success: true, ts: ts() })
			}
		} catch {
			// Ignore malformed input
		}
	})

	rl.on("close", () => {
		process.exit(0)
	})
}

// ---------------------------------------------------------------------------
// Stream mode
// ---------------------------------------------------------------------------

async function runStream(): Promise<void> {
	const streamUrl = process.env.DS_STREAM_URL
	const secret = process.env.DS_SECRET
	if (!streamUrl || !secret) {
		process.stderr.write("Error: DS_STREAM_URL and DS_SECRET required for --stream mode\n")
		process.exit(1)
	}

	// Dynamic import to avoid requiring @durable-streams/client at top-level
	const { DurableStream } = await import("@durable-streams/client")

	const headers = { Authorization: `Bearer ${secret}` }

	const writer = new DurableStream({
		url: streamUrl,
		headers,
		contentType: "application/json",
	})

	async function emit(event: Record<string, unknown>): Promise<void> {
		const msg = { source: "agent", ...event }
		await writer.append(JSON.stringify(msg))
	}

	const reader = new DurableStream({
		url: streamUrl,
		headers,
		contentType: "application/json",
	})

	const response = await reader.stream<Message>({
		offset: "-1",
		live: true,
	})

	let gotConfig = false

	response.subscribeJson<Message>((batch) => {
		for (const item of batch.items) {
			if (item.source !== "server") continue

			if (item.type === "command" && !gotConfig) {
				gotConfig = true
				const { source: _, type: _t, ...rest } = item
				emit({
					type: "log",
					level: "done",
					message: `Test agent received config via stream: command=${rest.command}`,
					ts: ts(),
				})
				emit({
					type: "echo_config",
					...rest,
					ts: ts(),
				})
				emit({ type: "session_complete", success: true, ts: ts() })
				return
			}

			if (item.type === "command") {
				const { source: _, type: _t, ...rest } = item
				emit({
					type: "echo_command",
					...rest,
					ts: ts(),
				})
				emit({ type: "session_complete", success: true, ts: ts() })
				continue
			}

			if (item.type === "gate_response") {
				const { source: _, type: _t, ...rest } = item
				emit({
					type: "echo_gate_response",
					...rest,
					ts: ts(),
				})
			}
		}
	})
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (mode === "stream") {
	runStream().catch((err) => {
		process.stderr.write(`Stream mode failed: ${err}\n`)
		process.exit(1)
	})
} else {
	runStdio().catch((err) => {
		process.stderr.write(`Stdio mode failed: ${err}\n`)
		process.exit(1)
	})
}
