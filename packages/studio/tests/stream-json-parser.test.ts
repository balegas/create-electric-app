import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createStreamJsonParser } from "../src/bridge/stream-json-parser.js"

describe("stream-json-parser", () => {
	it("parses system init to session_start", () => {
		const { parse } = createStreamJsonParser()
		const events = parse(
			JSON.stringify({
				type: "system",
				subtype: "init",
				session_id: "sess-123",
				tools: [],
				model: "claude-sonnet-4-6",
			}),
		)
		assert.equal(events.length, 1)
		assert.equal(events[0].type, "session_start")
		assert.equal((events[0] as { session_id: string }).session_id, "sess-123")
	})

	it("parses assistant text to assistant_message", () => {
		const { parse } = createStreamJsonParser()
		const events = parse(
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hello, I will help you." }],
				},
			}),
		)
		assert.equal(events.length, 1)
		assert.equal(events[0].type, "assistant_message")
		assert.equal((events[0] as { text: string }).text, "Hello, I will help you.")
	})

	it("silently ignores assistant thinking blocks", () => {
		const { parse } = createStreamJsonParser()
		const events = parse(
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "thinking", thinking: "Let me think about this..." }],
				},
			}),
		)
		assert.equal(events.length, 0)
	})

	it("parses tool_use to pre_tool_use", () => {
		const { parse } = createStreamJsonParser()
		const events = parse(
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "toolu_01",
							name: "Read",
							input: { file_path: "/src/app.tsx" },
						},
					],
				},
			}),
		)
		assert.equal(events.length, 1)
		assert.equal(events[0].type, "pre_tool_use")
		const evt = events[0] as {
			tool_name: string
			tool_use_id: string
			tool_input: Record<string, unknown>
		}
		assert.equal(evt.tool_name, "Read")
		assert.equal(evt.tool_use_id, "toolu_01")
		assert.deepEqual(evt.tool_input, { file_path: "/src/app.tsx" })
	})

	it("parses tool_result to post_tool_use", () => {
		const { parse } = createStreamJsonParser()
		// First register the tool via a tool_use
		parse(
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "tool_use", id: "toolu_01", name: "Read", input: {} }],
				},
			}),
		)
		const events = parse(
			JSON.stringify({
				type: "user",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_01",
							content: "file contents here",
						},
					],
				},
			}),
		)
		assert.equal(events.length, 1)
		assert.equal(events[0].type, "post_tool_use")
		const evt = events[0] as { tool_use_id: string; tool_response: string; tool_name?: string }
		assert.equal(evt.tool_use_id, "toolu_01")
		assert.equal(evt.tool_response, "file contents here")
		assert.equal(evt.tool_name, "Read")
	})

	it("parses tool_result with is_error", () => {
		const { parse } = createStreamJsonParser()
		parse(
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "tool_use", id: "toolu_02", name: "Bash", input: {} }],
				},
			}),
		)
		const events = parse(
			JSON.stringify({
				type: "user",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_02",
							content: "command not found",
							is_error: true,
						},
					],
				},
			}),
		)
		assert.equal(events.length, 1)
		const evt = events[0] as { type: string; error?: string; tool_response: string }
		assert.equal(evt.type, "post_tool_use")
		assert.equal(evt.error, "command not found")
		assert.equal(evt.tool_response, "command not found")
	})

	it("parses TodoWrite tool_use to todo_write event", () => {
		const { parse } = createStreamJsonParser()
		const todos = [
			{ id: "1", content: "Build schema", status: "completed" },
			{ id: "2", content: "Create UI", status: "in_progress" },
		]
		const events = parse(
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "toolu_03",
							name: "TodoWrite",
							input: { todos },
						},
					],
				},
			}),
		)
		assert.equal(events.length, 1)
		assert.equal(events[0].type, "todo_write")
		const evt = events[0] as { tool_use_id: string; todos: unknown[] }
		assert.equal(evt.tool_use_id, "toolu_03")
		assert.deepEqual(evt.todos, todos)
	})

	it("parses AskUserQuestion tool_use to ask_user_question event", () => {
		const { parse } = createStreamJsonParser()
		const events = parse(
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "toolu_04",
							name: "AskUserQuestion",
							input: {
								questions: [
									{
										question: "Which framework?",
										options: [
											{ label: "React", description: "Popular" },
											{ label: "Vue", description: "Progressive" },
										],
									},
								],
							},
						},
					],
				},
			}),
		)
		assert.equal(events.length, 1)
		assert.equal(events[0].type, "ask_user_question")
		const evt = events[0] as {
			tool_use_id: string
			question: string
			options?: Array<{ label: string; description?: string }>
		}
		assert.equal(evt.tool_use_id, "toolu_04")
		assert.equal(evt.question, "Which framework?")
		assert.equal(evt.options?.length, 2)
	})

	it("skips post_tool_use for TodoWrite and AskUserQuestion", () => {
		const { parse } = createStreamJsonParser()
		// Register both special tools
		parse(
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{ type: "tool_use", id: "toolu_todo", name: "TodoWrite", input: { todos: [] } },
						{
							type: "tool_use",
							id: "toolu_ask",
							name: "AskUserQuestion",
							input: { questions: [{ question: "?" }] },
						},
					],
				},
			}),
		)
		// Tool results for special tools should be skipped
		const events = parse(
			JSON.stringify({
				type: "user",
				message: {
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "toolu_todo", content: "ok" },
						{ type: "tool_result", tool_use_id: "toolu_ask", content: "answer" },
					],
				},
			}),
		)
		assert.equal(events.length, 0)
	})

	it("parses result to session_end", () => {
		const { parse } = createStreamJsonParser()
		const events = parse(
			JSON.stringify({
				type: "result",
				subtype: "success",
				session_id: "sess-123",
				cost_usd: 0.42,
				num_turns: 15,
				duration_ms: 60000,
			}),
		)
		assert.equal(events.length, 1)
		assert.equal(events[0].type, "session_end")
		assert.equal((events[0] as { success: boolean }).success, true)
	})

	it("parses non-success result as session_end with success=false", () => {
		const { parse } = createStreamJsonParser()
		const events = parse(
			JSON.stringify({
				type: "result",
				subtype: "error_max_turns",
				cost_usd: 1.5,
			}),
		)
		assert.equal(events.length, 1)
		assert.equal(events[0].type, "session_end")
		assert.equal((events[0] as { success: boolean }).success, false)
	})

	it("handles multi-block assistant messages (thinking blocks ignored)", () => {
		const { parse } = createStreamJsonParser()
		const events = parse(
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Planning..." },
						{ type: "text", text: "I'll create the file." },
						{
							type: "tool_use",
							id: "toolu_05",
							name: "Write",
							input: { file_path: "/app.tsx", content: "export default () => <div/>" },
						},
					],
				},
			}),
		)
		assert.equal(events.length, 2)
		assert.equal(events[0].type, "assistant_message")
		assert.equal(events[1].type, "pre_tool_use")
	})

	it("ignores empty lines and non-JSON", () => {
		const { parse } = createStreamJsonParser()
		assert.deepEqual(parse(""), [])
		assert.deepEqual(parse("   "), [])
		assert.deepEqual(parse("not json"), [])
	})

	it("ignores unknown message types", () => {
		const { parse } = createStreamJsonParser()
		assert.deepEqual(parse(JSON.stringify({ type: "stream_event", event: {} })), [])
		assert.deepEqual(parse(JSON.stringify({ type: "unknown" })), [])
	})

	it("tracks tool names across calls", () => {
		const { parse, state } = createStreamJsonParser()
		parse(
			JSON.stringify({
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "tool_use", id: "t1", name: "Edit", input: {} }],
				},
			}),
		)
		assert.equal(state.toolNames.get("t1"), "Edit")
	})

	it("tracks session_id from init", () => {
		const { parse, state } = createStreamJsonParser()
		parse(JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123" }))
		assert.equal(state.sessionId, "abc-123")
	})
})
