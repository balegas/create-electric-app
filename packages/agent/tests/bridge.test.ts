import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { EngineEvent } from "@electric-agent/protocol"

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
				type: "pre_tool_use",
				tool_name: "bash",
				tool_use_id: "123",
				tool_input: { command: "pnpm build" },
				ts: "t2",
			},
			{ type: "session_end", success: true, ts: "t3" },
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
