import type { ChildProcess } from "node:child_process"
import readline from "node:readline"
import { DurableStream } from "@durable-streams/client"
import type { EngineEvent } from "../engine/events.js"

/**
 * Bridge a container's stdout to a durable stream.
 *
 * Reads the container process stdout line by line, parses each line
 * as an EngineEvent, and appends it to the durable stream.
 */
export function bridgeContainerToStream(
	_sessionId: string,
	containerProcess: ChildProcess,
	streamUrl: string,
	onComplete: (success: boolean) => void,
): void {
	const stdout = containerProcess.stdout
	if (!stdout) {
		onComplete(false)
		return
	}

	const streamHandle = new DurableStream({
		url: streamUrl,
		contentType: "application/json",
	})

	const rl = readline.createInterface({
		input: stdout,
		terminal: false,
	})

	rl.on("line", (line) => {
		const trimmed = line.trim()
		if (!trimmed) return
		try {
			// Validate it's a valid EngineEvent by parsing
			const event = JSON.parse(trimmed) as EngineEvent
			if (event.type) {
				streamHandle.append(JSON.stringify(event)).catch(() => {
					// Stream may be closed, swallow error
				})
			}
		} catch {
			// Ignore malformed lines
		}
	})

	// Capture stderr for debugging
	if (containerProcess.stderr) {
		containerProcess.stderr.on("data", (data: Buffer) => {
			const msg = data.toString().trim()
			if (msg) {
				streamHandle
					.append(
						JSON.stringify({
							type: "log",
							level: "error",
							message: `[container] ${msg}`,
							ts: new Date().toISOString(),
						}),
					)
					.catch(() => {})
			}
		})
	}

	containerProcess.on("exit", (code) => {
		rl.close()
		onComplete(code === 0)
	})

	containerProcess.on("error", () => {
		rl.close()
		onComplete(false)
	})
}
