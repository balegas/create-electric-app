import type { EngineEvent } from "./events.js"
import { ts } from "./events.js"

/**
 * Parse an SDK message into one or more EngineEvents.
 * This mirrors the logic in processAgentMessage but produces structured events
 * instead of console output.
 */
export function sdkMessageToEvents(message: Record<string, unknown>): EngineEvent[] {
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
			} else if ("thinking" in block && block.thinking) {
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
	} else if (message.type === "user" && (message.message as Record<string, unknown>)?.content) {
		// SDK sends tool results as user messages with tool_result content blocks
		const msgContent = (message.message as Record<string, unknown>).content
		if (Array.isArray(msgContent)) {
			for (const block of msgContent) {
				if (
					typeof block === "object" &&
					block &&
					(block as Record<string, unknown>).type === "tool_result"
				) {
					const b = block as Record<string, unknown>
					const toolUseId = (b.tool_use_id || "") as string
					const content = b.content
					const texts: string[] = []
					if (typeof content === "string") {
						texts.push(content)
					} else if (Array.isArray(content)) {
						for (const inner of content) {
							if (typeof inner === "object" && inner && "text" in inner) {
								texts.push((inner as Record<string, unknown>).text as string)
							}
						}
					}
					events.push({
						type: "tool_result",
						toolUseId,
						output: texts.join("\n"),
						ts: ts(),
					})
				}
			}
		}
	} else if (message.type === "result") {
		const sub = String(message.subtype)
		const cost = message.total_cost_usd as number | undefined
		const costStr = `(cost: $${cost?.toFixed(4) || "?"})`

		if (cost !== undefined) {
			events.push({ type: "cost_update", totalCostUsd: cost, ts: ts() })
		}

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
