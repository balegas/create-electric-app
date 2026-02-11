import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { buildPlannerPrompt } from "./prompts.js"
import { createToolServer } from "../tools/server.js"
import { createProgressReporter, processAgentMessage } from "../progress/reporter.js"

/**
 * Run the planner agent to generate a PLAN.md from an app description.
 */
export async function runPlanner(
	appDescription: string,
	projectDir: string,
): Promise<string> {
	const reporter = createProgressReporter()
	const plannerPrompt = buildPlannerPrompt()
	const mcpServer = createToolServer()

	let planContent = ""

	async function* generateMessages(): AsyncGenerator<SDKUserMessage> {
		yield {
			type: "user" as const,
			session_id: "",
			parent_tool_use_id: null,
			message: {
				role: "user" as const,
				content: `Create a detailed implementation plan for the following app:\n\n${appDescription}\n\nProduce a PLAN.md following the format specified in your instructions. Include complete Drizzle pgTable() definitions for all entities.`,
			},
		}
	}

	for await (const message of query({
		prompt: generateMessages(),
		options: {
			model: "claude-opus-4-6",
			systemPrompt: plannerPrompt,
			maxThinkingTokens: 16384,
			allowedTools: [
				"mcp__electric-agent-tools__read_playbook",
				"mcp__electric-agent-tools__list_playbooks",
			],
			mcpServers: { "electric-agent-tools": mcpServer },
			cwd: projectDir,
			maxTurns: 10,
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
		},
	})) {
		processAgentMessage(message, reporter)

		// Capture the final text output as the plan
		if (message.type === "assistant" && message.message?.content) {
			for (const block of message.message.content) {
				if ("text" in block && block.text) {
					planContent = block.text as string
				}
			}
		}
	}

	return planContent
}
