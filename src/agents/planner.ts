import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { createProgressReporter, processAgentMessage } from "../progress/reporter.js"
import { createToolServer } from "../tools/server.js"
import { buildPlannerPrompt } from "./prompts.js"

/**
 * Run the planner agent to generate a PLAN.md from an app description.
 */
export async function runPlanner(appDescription: string, projectDir: string): Promise<string> {
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
				content: `Create a detailed implementation plan for this app: "${appDescription}"

Follow these steps in order:
1. Use list_playbooks to see available playbooks
2. Use read_playbook for these specific playbooks: electric-quickstart, tanstack-db-collections, tanstack-db-mutations
3. Then produce the PLAN.md content as your final text response — include complete Drizzle pgTable() definitions for ALL entities

IMPORTANT: Do NOT explore the filesystem or run shell commands. Just read the playbooks and produce the plan.`,
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
				"Read",
				"Glob",
				"mcp__electric-agent-tools__read_playbook",
				"mcp__electric-agent-tools__list_playbooks",
			],
			mcpServers: { "electric-agent-tools": mcpServer },
			cwd: projectDir,
			maxTurns: 20,
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
