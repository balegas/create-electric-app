/**
 * Translates Codex CLI `codex exec --json` NDJSON messages
 * into EngineEvent arrays compatible with the existing bridge/UI pipeline.
 *
 * Codex exec --json emits lines like:
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"item.started","item":{"type":"command_execution","id":"...","command":"..."}}
 *   {"type":"item.completed","item":{"type":"agent_message","id":"...","content":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}
 *   {"type":"turn.failed","error":"..."}
 *
 * This parser converts each line into zero or more EngineEvent objects.
 */

import type { EngineEvent } from "@electric-agent/protocol"
import { ts } from "@electric-agent/protocol"

// ---------------------------------------------------------------------------
// Codex exec --json types (subset we care about)
// ---------------------------------------------------------------------------

interface CodexThreadStarted {
	type: "thread.started"
	thread_id?: string
}

interface CodexItemStarted {
	type: "item.started"
	item: CodexItem
}

interface CodexItemCompleted {
	type: "item.completed"
	item: CodexItem
}

interface CodexTurnCompleted {
	type: "turn.completed"
	usage?: {
		input_tokens?: number
		output_tokens?: number
		total_tokens?: number
	}
	cost_usd?: number
}

interface CodexTurnFailed {
	type: "turn.failed"
	error?: string
}

type CodexItem =
	| CodexAgentMessage
	| CodexCommandExecution
	| CodexFileChange
	| CodexMcpToolCall
	| CodexReasoning
	| { type: string; id?: string; [key: string]: unknown }

interface CodexAgentMessage {
	type: "agent_message"
	id?: string
	content?: string | Array<{ type: string; text?: string }>
}

interface CodexCommandExecution {
	type: "command_execution"
	id?: string
	command?: string
	exit_code?: number
	output?: string
}

interface CodexFileChange {
	type: "file_change"
	id?: string
	file_path?: string
	action?: string
	content?: string
	diff?: string
}

interface CodexMcpToolCall {
	type: "mcp_tool_call"
	id?: string
	tool_name?: string
	server_name?: string
	arguments?: Record<string, unknown>
	result?: string
}

interface CodexReasoning {
	type: "reasoning"
	id?: string
	content?: string
}

type CodexEvent =
	| CodexThreadStarted
	| CodexItemStarted
	| CodexItemCompleted
	| CodexTurnCompleted
	| CodexTurnFailed
	| { type: string; [key: string]: unknown }

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export interface CodexJsonParserState {
	/** Map item ID → tool name for correlating started/completed events */
	toolNames: Map<string, string>
	/** Accumulated cost from turn.completed messages */
	totalCost: number
	/** Codex thread ID from thread.started */
	threadId: string | null
}

/**
 * Create a new stateful parser. The returned `parse` function converts
 * a single raw JSON line from Codex into zero or more EngineEvents.
 */
export function createCodexJsonParser() {
	const state: CodexJsonParserState = {
		toolNames: new Map(),
		totalCost: 0,
		threadId: null,
	}

	return {
		state,
		parse(line: string): EngineEvent[] {
			return parseLine(line, state)
		},
	}
}

function parseLine(line: string, state: CodexJsonParserState): EngineEvent[] {
	const trimmed = line.trim()
	if (!trimmed) return []

	let msg: CodexEvent
	try {
		msg = JSON.parse(trimmed)
	} catch {
		return []
	}

	if (!msg.type) return []

	switch (msg.type) {
		case "thread.started":
			return handleThreadStarted(msg as CodexThreadStarted, state)
		case "item.started":
			return handleItemStarted(msg as CodexItemStarted, state)
		case "item.completed":
			return handleItemCompleted(msg as CodexItemCompleted, state)
		case "turn.completed":
			return handleTurnCompleted(msg as CodexTurnCompleted, state)
		case "turn.failed":
			return handleTurnFailed(msg as CodexTurnFailed)
		default:
			return []
	}
}

function handleThreadStarted(msg: CodexThreadStarted, state: CodexJsonParserState): EngineEvent[] {
	state.threadId = msg.thread_id ?? null
	return [
		{
			type: "session_start",
			session_id: msg.thread_id ?? "",
			ts: ts(),
		},
	]
}

function handleItemStarted(msg: CodexItemStarted, state: CodexJsonParserState): EngineEvent[] {
	const item = msg.item
	if (!item?.type) return []

	switch (item.type) {
		case "command_execution": {
			const ce = item as CodexCommandExecution
			const toolUseId = ce.id ?? `codex_${Date.now()}`
			state.toolNames.set(toolUseId, "Bash")
			return [
				{
					type: "pre_tool_use",
					tool_name: "Bash",
					tool_use_id: toolUseId,
					tool_input: { command: ce.command ?? "" },
					ts: ts(),
				},
			]
		}

		case "file_change": {
			const fc = item as CodexFileChange
			const toolUseId = fc.id ?? `codex_${Date.now()}`
			const toolName = fc.action === "delete" ? "Delete" : "Write"
			state.toolNames.set(toolUseId, toolName)
			return [
				{
					type: "pre_tool_use",
					tool_name: toolName,
					tool_use_id: toolUseId,
					tool_input: { file_path: fc.file_path ?? "", action: fc.action ?? "write" },
					ts: ts(),
				},
			]
		}

		case "mcp_tool_call": {
			const mc = item as CodexMcpToolCall
			const toolUseId = mc.id ?? `codex_${Date.now()}`
			const toolName = mc.tool_name
				? mc.server_name
					? `mcp__${mc.server_name}__${mc.tool_name}`
					: mc.tool_name
				: "mcp_tool"
			state.toolNames.set(toolUseId, toolName)
			return [
				{
					type: "pre_tool_use",
					tool_name: toolName,
					tool_use_id: toolUseId,
					tool_input: mc.arguments ?? {},
					ts: ts(),
				},
			]
		}

		case "reasoning": {
			const r = item as CodexReasoning
			if (r.content) {
				return [
					{
						type: "assistant_thinking",
						text: r.content,
						ts: ts(),
					},
				]
			}
			return []
		}

		default:
			return []
	}
}

function handleItemCompleted(msg: CodexItemCompleted, state: CodexJsonParserState): EngineEvent[] {
	const item = msg.item
	if (!item?.type) return []

	switch (item.type) {
		case "agent_message": {
			const am = item as CodexAgentMessage
			const text = extractMessageText(am.content)
			if (text) {
				return [
					{
						type: "assistant_message",
						text,
						ts: ts(),
					},
				]
			}
			return []
		}

		case "command_execution": {
			const ce = item as CodexCommandExecution
			const toolUseId = ce.id ?? ""
			const toolName = state.toolNames.get(toolUseId) ?? "Bash"
			const isError = ce.exit_code != null && ce.exit_code !== 0
			const response = ce.output ?? ""

			if (isError) {
				return [
					{
						type: "post_tool_use",
						tool_use_id: toolUseId,
						tool_name: toolName,
						tool_response: response,
						error: response || `Exit code: ${ce.exit_code}`,
						ts: ts(),
					},
				]
			}
			return [
				{
					type: "post_tool_use",
					tool_use_id: toolUseId,
					tool_name: toolName,
					tool_response: response,
					ts: ts(),
				},
			]
		}

		case "file_change": {
			const fc = item as CodexFileChange
			const toolUseId = fc.id ?? ""
			const toolName = state.toolNames.get(toolUseId) ?? "Write"
			return [
				{
					type: "post_tool_use",
					tool_use_id: toolUseId,
					tool_name: toolName,
					tool_response:
						fc.diff ?? fc.content ?? `File ${fc.action ?? "changed"}: ${fc.file_path ?? ""}`,
					ts: ts(),
				},
			]
		}

		case "mcp_tool_call": {
			const mc = item as CodexMcpToolCall
			const toolUseId = mc.id ?? ""
			const toolName = state.toolNames.get(toolUseId) ?? "mcp_tool"
			return [
				{
					type: "post_tool_use",
					tool_use_id: toolUseId,
					tool_name: toolName,
					tool_response: mc.result ?? "",
					ts: ts(),
				},
			]
		}

		case "reasoning": {
			const r = item as CodexReasoning
			if (r.content) {
				return [
					{
						type: "assistant_thinking",
						text: r.content,
						ts: ts(),
					},
				]
			}
			return []
		}

		default:
			return []
	}
}

function handleTurnCompleted(msg: CodexTurnCompleted, state: CodexJsonParserState): EngineEvent[] {
	const events: EngineEvent[] = []

	if (msg.cost_usd != null) {
		state.totalCost += msg.cost_usd
		events.push({
			type: "cost_update",
			totalCostUsd: state.totalCost,
			ts: ts(),
		})
	}

	return events
}

function handleTurnFailed(msg: CodexTurnFailed): EngineEvent[] {
	return [
		{
			type: "log",
			level: "error",
			message: msg.error ?? "Turn failed",
			ts: ts(),
		},
	]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractMessageText(
	content: string | Array<{ type: string; text?: string }> | undefined,
): string {
	if (content == null) return ""
	if (typeof content === "string") return content
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (block.type === "text" && typeof block.text === "string") return block.text
				return ""
			})
			.filter(Boolean)
			.join("\n")
	}
	return String(content)
}
