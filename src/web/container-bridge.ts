import type { ChildProcess } from "node:child_process"
import readline from "node:readline"
import { DurableStream } from "@durable-streams/client"
import type { EngineEvent } from "../engine/events.js"

/**
 * Bridge a container's stdout to a durable stream.
 *
 * Reads the container process stdout line by line, parses each line
 * as an EngineEvent, and appends it to the durable stream.
 *
 * @deprecated Will be replaced by SessionBridge in Phase 5
 */
export function bridgeContainerToStream(
	_sessionId: string,
	containerProcess: ChildProcess,
	streamUrl: string,
	onComplete: (success: boolean) => void,
	streamHeaders?: Record<string, string>,
): void {
	const stdout = containerProcess.stdout
	if (!stdout) {
		onComplete(false)
		return
	}

	const streamHandle = new DurableStream({
		url: streamUrl,
		headers: streamHeaders,
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

				// Notify on session_complete (agent may send multiple across iterations)
				if (event.type === "session_complete") {
					onComplete((event as EngineEvent & { success?: boolean }).success !== false)
				}
			}
		} catch {
			// Ignore malformed lines
		}
	})

	// Capture stderr — classify infra/dev-server messages as info, actual errors as error
	if (containerProcess.stderr) {
		const infraPattern =
			/\b(Creating|Created|Running|Started|Waiting|Healthy|Pulling|Pulled|Starting|Stopping|Stopped|Removing|Removed|Building|Built|Network|Volume)\b/i
		const devServerPattern = /\bVITE\b|^\s*>|➜|vite\s+(dev|build)|HMR|\[vite\]/i
		const viteReadyPattern = /VITE\s+v[\d.]+\s+ready/i

		containerProcess.stderr.on("data", (data: Buffer) => {
			const msg = data.toString().trim()
			if (!msg) return

			const isInfra = infraPattern.test(msg)
			const isDevServer = devServerPattern.test(msg)
			const level = isInfra || isDevServer ? "info" : "error"

			streamHandle
				.append(
					JSON.stringify({
						type: "log",
						level,
						message: `[container] ${msg}`,
						ts: new Date().toISOString(),
					}),
				)
				.catch(() => {})

			// Emit app_ready when Vite reports it's listening
			if (viteReadyPattern.test(msg)) {
				streamHandle
					.append(
						JSON.stringify({
							type: "app_ready",
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
