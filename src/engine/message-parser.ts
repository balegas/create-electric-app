import type { EngineEvent } from "./events.js"
import { ts } from "./events.js"

/**
 * Parse an SDK message into one or more EngineEvents.
 * This mirrors the logic in processAgentMessage but produces structured events
 * instead of console output.
 */
export function sdkMessageToEvents(
	message: Record<string, unknown>,
	debugMode: boolean,
): EngineEvent[] {
	const events: EngineEvent[] = []

	if (message.type === "assistant" && (message.message as Record<string, unknown>)?.content) {
		const content = (message.message as Record<string, unknown>).content as Record<
			string,
			unknown
		>[]
		for (const block of content) {
			if ("text" in block && block.text) {
				const text = block.text as string
				events.push({ type: "assistant_text", text, ts: ts() })
			} else if ("thinking" in block && block.thinking && debugMode) {
				events.push({
					type: "assistant_thinking",
					text: block.thinking as string,
					ts: ts(),
				})
			} else if ("name" in block) {
				const name = block.name as string
				const input = (block.input || {}) as Record<string, unknown>
				const toolUseId = (block.id || `tool_${Date.now()}`) as string

				events.push({
					type: "tool_start",
					toolName: name,
					toolUseId,
					input,
					ts: ts(),
				})
			}
		}
	} else if (message.type === "tool_result") {
		const toolUseId = (message.tool_use_id || "") as string
		const content = (message as Record<string, unknown>).content
		const texts: string[] = []
		if (typeof content === "string") {
			texts.push(content)
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (typeof block === "object" && block && "text" in block) {
					texts.push(block.text as string)
				}
			}
		}

		events.push({
			type: "tool_result",
			toolUseId,
			output: texts.join("\n"),
			ts: ts(),
		})
	} else if (message.type === "result") {
		const sub = String(message.subtype)
		const cost = message.total_cost_usd as number | undefined
		const costStr = `(cost: $${cost?.toFixed(4) || "?"})`
		if (sub === "success") {
			events.push({
				type: "log",
				level: "done",
				message: `Agent completed ${costStr}`,
				ts: ts(),
			})
		} else if (sub.includes("max_turns")) {
			events.push({
				type: "log",
				level: "task",
				message: `Agent reached turn limit ${costStr}`,
				ts: ts(),
			})
		} else {
			events.push({
				type: "log",
				level: "error",
				message: `Agent stopped: ${sub} ${costStr}`,
				ts: ts(),
			})
		}
	}

	return events
}
