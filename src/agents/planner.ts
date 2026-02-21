import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { DEFAULT_PLANNER_CONFIG, type PlannerModelConfig } from "../engine/model-settings.js"
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
	onMessage?: (msg: Record<string, unknown>) => void,
	abortController?: AbortController,
	modelConfig?: Partial<PlannerModelConfig>,
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

Steps:
1. list_playbooks — discover available playbook skills and their descriptions
2. read_playbook("electric-app-guardrails") — critical integration rules
3. Read 1-2 more playbooks relevant to this app (based on what list_playbooks returned)
4. Output the complete PLAN.md with Drizzle pgTable() definitions for ALL entities

The plan must include read_playbook instructions in each phase so the coder reads the right playbook before coding that phase (see system prompt for format).`,
			},
		}
	}

	const cfg = { ...DEFAULT_PLANNER_CONFIG, ...modelConfig }

	const queryOptions: Record<string, unknown> = {
		model: cfg.model,
		systemPrompt: plannerPrompt,
		maxThinkingTokens: cfg.maxThinkingTokens,
		allowedTools: [
			"WebSearch",
			"mcp__electric-agent-tools__read_playbook",
			"mcp__electric-agent-tools__list_playbooks",
		],
		mcpServers: { "electric-agent-tools": mcpServer },
		hooks: plannerHooks,
		cwd: projectDir,
		maxTurns: cfg.maxTurns,
		permissionMode: "bypassPermissions",
		allowDangerouslySkipPermissions: true,
	}

	if (abortController) {
		queryOptions.abortController = abortController
	}

	for await (const message of query({
		prompt: generateMessages(),
		options: queryOptions,
	})) {
		processAgentMessage(message, r)
		onMessage?.(message)

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
