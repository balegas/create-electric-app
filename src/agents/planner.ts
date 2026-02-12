import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { plannerHooks } from "../hooks/index.js"
import {
	createProgressReporter,
	type ProgressReporter,
	processAgentMessage,
} from "../progress/reporter.js"
import { createToolServer } from "../tools/server.js"
import { buildPlannerPrompt } from "./prompts.js"

/**
 * Run the planner agent to generate a PLAN.md from an app description.
 */
export async function runPlanner(
	appDescription: string,
	projectDir: string,
	reporter?: ProgressReporter,
): Promise<string> {
	const r = reporter ?? createProgressReporter()
	const plannerPrompt = buildPlannerPrompt()
	const mcpServer = createToolServer(projectDir, r)

	let planContent = ""

	async function* generateMessages(): AsyncGenerator<SDKUserMessage> {
		yield {
			type: "user" as const,
			session_id: "",
			parent_tool_use_id: null,
			message: {
				role: "user" as const,
				content: `Create a detailed implementation plan for this app: "${appDescription}"

Steps (exactly 3 tool calls, then output):
1. list_playbooks — see what's available
2. read_playbook("electric-quickstart")
3. read_playbook("tanstack-db")
4. Output the PLAN.md with complete Drizzle pgTable() definitions for ALL entities

Do NOT read any other playbooks. Do NOT explore the filesystem. The coder agent reads specific playbooks (collections, mutations, etc.) as it works on each phase.`,
			},
		}
	}

	for await (const message of query({
		prompt: generateMessages(),
		options: {
			model: "claude-opus-4-6",
			systemPrompt: plannerPrompt,
			maxThinkingTokens: 10000,
			allowedTools: [
				"mcp__electric-agent-tools__read_playbook",
				"mcp__electric-agent-tools__list_playbooks",
			],
			mcpServers: { "electric-agent-tools": mcpServer },
			hooks: plannerHooks,
			cwd: projectDir,
			maxTurns: 10,
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
		},
	})) {
		processAgentMessage(message, r)

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
