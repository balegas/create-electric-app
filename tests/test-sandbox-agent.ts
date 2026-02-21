/**
 * Minimal test agent for integration testing.
 *
 * Reads commands from a hosted Durable Stream, writes events back.
 * The agent echoes back received commands as events (prefixed with "echo_")
 * and emits session_complete when done. This validates the full
 * communication pipeline without running actual Claude agents.
 *
 * Required env vars: DS_URL, DS_SERVICE_ID, DS_SECRET, SESSION_ID
 */

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

async function main(): Promise<void> {
	const dsUrl = process.env.DS_URL
	const dsServiceId = process.env.DS_SERVICE_ID
	const dsSecret = process.env.DS_SECRET
	const sessionId = process.env.SESSION_ID

	if (!dsUrl || !dsServiceId || !dsSecret || !sessionId) {
		process.stderr.write(
			"Error: DS_URL, DS_SERVICE_ID, DS_SECRET, and SESSION_ID are required\n",
		)
		process.exit(1)
	}

	const streamUrl = `${dsUrl}/v1/stream/${dsServiceId}/session/${sessionId}`
	const headers = { Authorization: `Bearer ${dsSecret}` }

	// Dynamic import to avoid requiring @durable-streams/client at top-level
	const { DurableStream } = await import("@durable-streams/client")

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

main().catch((err) => {
	process.stderr.write(`Test agent failed: ${err}\n`)
	process.exit(1)
})
