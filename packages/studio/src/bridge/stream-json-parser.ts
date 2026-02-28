/**
 * Translates Claude Code `--output-format stream-json` NDJSON messages
 * into EngineEvent arrays compatible with the existing bridge/UI pipeline.
 *
 * Claude Code emits lines like:
 *   {"type":"system","subtype":"init","session_id":"...","tools":[...]}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"...","content":"..."}]}}
 *   {"type":"result","subtype":"success","cost_usd":0.12,"num_turns":5}
 *
 * This parser converts each line into zero or more EngineEvent objects.
 */

import type { EngineEvent } from "@electric-agent/protocol"
import { ts } from "@electric-agent/protocol"

// ---------------------------------------------------------------------------
// Claude Code stream-json types (subset we care about)
// ---------------------------------------------------------------------------

interface StreamJsonSystemInit {
	type: "system"
	subtype: "init"
	session_id?: string
	tools?: unknown[]
	model?: string
}

interface StreamJsonAssistant {
	type: "assistant"
	message: {
		role: "assistant"
		content: ContentBlock[]
	}
}

interface StreamJsonUser {
	type: "user"
	message: {
		role: "user"
		content: ContentBlock[]
	}
}

interface StreamJsonResult {
	type: "result"
	subtype: string
	session_id?: string
	cost_usd?: number
	num_turns?: number
	duration_ms?: number
	duration_api_ms?: number
}

type StreamJsonMessage =
	| StreamJsonSystemInit
	| StreamJsonAssistant
	| StreamJsonUser
	| StreamJsonResult
	| { type: string; [key: string]: unknown }

type ContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
	| {
			type: "tool_result"
			tool_use_id: string
			content: string | ContentBlock[]
			is_error?: boolean
	  }

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export interface StreamJsonParserState {
	/** Map tool_use_id → tool_name for correlating post_tool_use events */
	toolNames: Map<string, string>
	/** Accumulated cost from result messages */
	totalCost: number
	/** Claude Code session ID from init */
	sessionId: string | null
}

/**
 * Create a new stateful parser. The returned `parse` function converts
 * a single raw JSON line from Claude Code into zero or more EngineEvents.
 */
export function createStreamJsonParser() {
	const state: StreamJsonParserState = {
		toolNames: new Map(),
		totalCost: 0,
		sessionId: null,
	}

	return {
		state,
		parse(line: string): EngineEvent[] {
			return parseLine(line, state)
		},
	}
}

function parseLine(line: string, state: StreamJsonParserState): EngineEvent[] {
	const trimmed = line.trim()
	if (!trimmed) return []

	let msg: StreamJsonMessage
	try {
		msg = JSON.parse(trimmed)
	} catch {
		return []
	}

	if (!msg.type) return []

	switch (msg.type) {
		case "system":
			return handleSystem(msg as StreamJsonSystemInit, state)
		case "assistant":
			return handleAssistant(msg as StreamJsonAssistant, state)
		case "user":
			return handleUser(msg as StreamJsonUser, state)
		case "result":
			return handleResult(msg as StreamJsonResult, state)
		default:
			// Ignore unknown message types (stream_event, etc.)
			return []
	}
}

function handleSystem(msg: StreamJsonSystemInit, state: StreamJsonParserState): EngineEvent[] {
	if (msg.subtype === "init") {
		state.sessionId = msg.session_id ?? null
		return [
			{
				type: "session_start",
				session_id: msg.session_id ?? "",
				ts: ts(),
			},
		]
	}
	return []
}

function handleAssistant(msg: StreamJsonAssistant, state: StreamJsonParserState): EngineEvent[] {
	const events: EngineEvent[] = []
	const content = msg.message?.content
	if (!Array.isArray(content)) return events

	for (const block of content) {
		switch (block.type) {
			case "text":
				if (block.text) {
					events.push({
						type: "assistant_message",
						text: block.text,
						ts: ts(),
					})
				}
				break

			case "thinking":
				if (block.thinking) {
					events.push({
						type: "assistant_thinking",
						text: block.thinking,
						ts: ts(),
					})
				}
				break

			case "tool_use": {
				// Track tool name for post_tool_use correlation
				state.toolNames.set(block.id, block.name)

				// Special tools get their own event types
				if (block.name === "TodoWrite") {
					events.push({
						type: "todo_write",
						tool_use_id: block.id,
						todos:
							(block.input.todos as Array<{
								id: string
								content: string
								status: string
								priority?: string
							}>) ?? [],
						ts: ts(),
					})
					break
				}

				if (block.name === "AskUserQuestion") {
					const questions = block.input.questions as
						| Array<{
								question: string
								options?: Array<{ label: string; description?: string }>
						  }>
						| undefined
					const firstQuestion = questions?.[0]
					events.push({
						type: "ask_user_question",
						tool_use_id: block.id,
						question: firstQuestion?.question ?? (block.input.question as string) ?? "",
						options: firstQuestion?.options,
						ts: ts(),
					})
					break
				}

				events.push({
					type: "pre_tool_use",
					tool_name: block.name,
					tool_use_id: block.id,
					tool_input: block.input,
					ts: ts(),
				})
				break
			}
		}
	}

	return events
}

function handleUser(msg: StreamJsonUser, state: StreamJsonParserState): EngineEvent[] {
	const events: EngineEvent[] = []
	const content = msg.message?.content
	if (!Array.isArray(content)) return events

	for (const block of content) {
		if (block.type !== "tool_result") continue

		const toolName = state.toolNames.get(block.tool_use_id)

		// Skip post_tool_use for special tools that have their own events
		if (toolName === "TodoWrite" || toolName === "AskUserQuestion") continue

		const response = extractToolResultText(block.content)

		if (block.is_error) {
			events.push({
				type: "post_tool_use",
				tool_use_id: block.tool_use_id,
				tool_name: toolName,
				tool_response: response,
				error: response,
				ts: ts(),
			})
		} else {
			events.push({
				type: "post_tool_use",
				tool_use_id: block.tool_use_id,
				tool_name: toolName,
				tool_response: response,
				ts: ts(),
			})
		}
	}

	return events
}

function handleResult(msg: StreamJsonResult, state: StreamJsonParserState): EngineEvent[] {
	const events: EngineEvent[] = []

	if (msg.cost_usd != null) {
		state.totalCost = msg.cost_usd
		events.push({
			type: "cost_update",
			totalCostUsd: msg.cost_usd,
			ts: ts(),
		})
	}

	const success = msg.subtype === "success"
	events.push({
		type: "session_end",
		success,
		ts: ts(),
	})

	return events
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractToolResultText(content: string | ContentBlock[] | undefined): string {
	if (content == null) return ""
	if (typeof content === "string") return content
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if ("text" in block && typeof block.text === "string") return block.text
				return ""
			})
			.filter(Boolean)
			.join("\n")
	}
	return String(content)
}
