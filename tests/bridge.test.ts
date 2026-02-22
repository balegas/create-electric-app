import { type ChildProcess, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as readline from "node:readline"
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { EngineEvent } from "../src/engine/events.js"

// ---------------------------------------------------------------------------
// NDJSON protocol unit tests
// ---------------------------------------------------------------------------

describe("NDJSON protocol", () => {
	it("should encode events as single-line JSON terminated by newline", () => {
		const event: EngineEvent = {
			type: "log",
			level: "task",
			message: "Planning...",
			ts: "2025-01-01T00:00:00Z",
		}
		const encoded = `${JSON.stringify(event)}\n`
		assert.ok(encoded.endsWith("\n"))
		assert.ok(!encoded.slice(0, -1).includes("\n"))
		const decoded = JSON.parse(encoded.trim())
		assert.deepStrictEqual(decoded, event)
	})

	it("should encode commands with type field", () => {
		const cmd = {
			type: "command",
			command: "new",
			description: "a todo app",
			projectName: "my-app",
			baseDir: "/home/agent/workspace",
		}
		const encoded = `${JSON.stringify(cmd)}\n`
		const decoded = JSON.parse(encoded.trim()) as Record<string, unknown>
		assert.equal(decoded.type, "command")
		assert.equal(decoded.command, "new")
		assert.equal(decoded.description, "a todo app")
	})

	it("should encode gate responses with type and gate fields", () => {
		const gateResponse = {
			type: "gate_response",
			gate: "approval",
			decision: "approve",
		}
		const encoded = `${JSON.stringify(gateResponse)}\n`
		const decoded = JSON.parse(encoded.trim()) as Record<string, unknown>
		assert.equal(decoded.type, "gate_response")
		assert.equal(decoded.gate, "approval")
		assert.equal(decoded.decision, "approve")
	})

	it("should handle events with special characters in messages", () => {
		const event: EngineEvent = {
			type: "log",
			level: "task",
			message: 'Line with "quotes" and\ttabs',
			ts: "2025-01-01T00:00:00Z",
		}
		const encoded = `${JSON.stringify(event)}\n`
		const decoded = JSON.parse(encoded.trim()) as EngineEvent
		assert.equal(decoded.type, "log")
		if (decoded.type === "log") {
			assert.equal(decoded.message, 'Line with "quotes" and\ttabs')
		}
	})

	it("should handle multiple NDJSON lines", () => {
		const events: EngineEvent[] = [
			{ type: "log", level: "task", message: "First", ts: "t1" },
			{
				type: "tool_start",
				toolName: "bash",
				toolUseId: "123",
				input: { command: "pnpm build" },
				ts: "t2",
			},
			{ type: "session_complete", success: true, ts: "t3" },
		]
		const ndjson = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`
		const lines = ndjson.trim().split("\n")
		assert.equal(lines.length, 3)
		for (let i = 0; i < lines.length; i++) {
			const parsed = JSON.parse(lines[i]) as EngineEvent
			assert.equal(parsed.type, events[i].type)
		}
	})
})

// ---------------------------------------------------------------------------
// stdio adapter integration test — spawn a child process that uses createStdioAdapter
// ---------------------------------------------------------------------------

describe("stdio adapter roundtrip", () => {
	it("should read config, receive events, and handle gate responses via stdin/stdout", async () => {
		// Inline TypeScript script that imports the stdio adapter
		// Uses the project root as cwd so tsx can resolve the import
		const script = `
import { createStdioAdapter } from "${process.cwd()}/src/engine/stdio-adapter.js"

const adapter = createStdioAdapter()
const { readConfig, callbacks, close } = adapter

// Read initial config
const config = await readConfig()
process.stdout.write(JSON.stringify({ type: "log", level: "done", message: "got config: " + config.command, ts: "t1" }) + "\\n")

// Emit a clarification event and wait for gate response
callbacks.onEvent({ type: "clarification_needed", questions: ["What color?"], confidence: 0.5, summary: "Need clarification", ts: "t2" })

const answers = await callbacks.onClarificationNeeded(["What color?"], "Need clarification")
process.stdout.write(JSON.stringify({ type: "log", level: "done", message: "got answers: " + answers.join(","), ts: "t3" }) + "\\n")

// Signal completion
process.stdout.write(JSON.stringify({ type: "session_complete", success: true, ts: "t4" }) + "\\n")

close()
`
		const tmpDir = os.tmpdir()
		const scriptPath = path.join(tmpDir, `stdio-test-${Date.now()}.mts`)
		fs.writeFileSync(scriptPath, script, "utf-8")

		try {
			const proc = spawn("npx", ["tsx", scriptPath], {
				stdio: ["pipe", "pipe", "pipe"],
				cwd: process.cwd(),
			})

			const collectedEvents: EngineEvent[] = []
			let stderrOutput = ""

			const rl = readline.createInterface({
				input: proc.stdout!,
				terminal: false,
			})

			if (proc.stderr) {
				proc.stderr.on("data", (chunk) => {
					stderrOutput += chunk.toString()
				})
			}

			const eventPromise = new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(
					() =>
						reject(
							new Error(
								`Timeout waiting for events. Collected: ${JSON.stringify(collectedEvents)}. Stderr: ${stderrOutput}`,
							),
						),
					15_000,
				)

				rl.on("line", (line) => {
					const trimmed = line.trim()
					if (!trimmed) return
					try {
						const event = JSON.parse(trimmed) as EngineEvent
						collectedEvents.push(event)

						// After receiving the clarification event, send the gate response
						if (event.type === "clarification_needed") {
							const gateResponse = JSON.stringify({
								type: "gate_response",
								gate: "clarification",
								answers: ["blue"],
							})
							proc.stdin!.write(`${gateResponse}\n`)
						}

						if (event.type === "session_complete") {
							clearTimeout(timeout)
							resolve()
						}
					} catch {
						// Non-JSON line, ignore
					}
				})

				proc.on("exit", (code) => {
					clearTimeout(timeout)
					if (collectedEvents.length === 0) {
						reject(
							new Error(
								`Process exited with code ${code} without producing events. Stderr: ${stderrOutput}`,
							),
						)
					}
				})
			})

			// Send the initial config command
			const configCmd = JSON.stringify({
				type: "command",
				command: "new",
				description: "test app",
				projectName: "test-project",
				baseDir: "/tmp",
			})
			proc.stdin!.write(`${configCmd}\n`)

			await eventPromise

			// Verify we got the expected events
			assert.ok(
				collectedEvents.length >= 3,
				`Expected at least 3 events, got ${collectedEvents.length}: ${JSON.stringify(collectedEvents)}`,
			)

			// Check for "got config: new" log
			const logEvents = collectedEvents.filter(
				(e) => e.type === "log" && "message" in e,
			) as Array<{ type: "log"; message: string }>
			assert.ok(
				logEvents.some((e) => e.message.includes("got config: new")),
				"Should have received config confirmation",
			)
			assert.ok(
				logEvents.some((e) => e.message.includes("got answers: blue")),
				"Should have received gate response answers",
			)

			// Last event: session_complete
			const lastEvent = collectedEvents[collectedEvents.length - 1]
			assert.equal(lastEvent.type, "session_complete")

			proc.kill("SIGTERM")
		} finally {
			fs.unlinkSync(scriptPath)
		}
	})
})
