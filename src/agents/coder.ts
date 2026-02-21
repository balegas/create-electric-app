import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { type CoderModelConfig, DEFAULT_CODER_CONFIG } from "../engine/model-settings.js"
import { createCoderHooks } from "../hooks/index.js"
import {
	createProgressReporter,
	type ProgressReporter,
	processAgentMessage,
} from "../progress/reporter.js"
import { createToolServer } from "../tools/server.js"
import { consecutiveIdenticalFailures, logError } from "../working-memory/errors.js"
import { updateSession } from "../working-memory/session.js"
import { buildCoderPrompt } from "./prompts.js"

export type StopReason = "complete" | "max_turns" | "max_budget" | "error"

export interface CoderResult {
	success: boolean
	errors: string[]
	stopReason: StopReason
	/** SDK session ID — pass to resumeSessionId to continue with full conversation context */
	sessionId?: string
}

/**
 * Run the coder agent to execute tasks from PLAN.md.
 */
export async function runCoder(
	projectDir: string,
	task?: string,
	reporter?: ProgressReporter,
	onMessage?: (msg: Record<string, unknown>) => void,
	resumeSessionId?: string,
	abortController?: AbortController,
	modelConfig?: Partial<CoderModelConfig>,
): Promise<CoderResult> {
	const r = reporter ?? createProgressReporter()
	const coderPrompt = buildCoderPrompt(projectDir)
	const mcpServer = createToolServer(projectDir, r)
	const errors: string[] = []
	let success = true
	let stopReason: StopReason = "complete"
	let sessionId: string | undefined

	const prompt =
		task ||
		"Read PLAN.md and execute ALL unchecked tasks in order. After completing each task, mark it as done with [x] in PLAN.md. Run the build tool after each phase to verify the code compiles. Continue until all tasks are checked off."

	await updateSession(projectDir, {
		currentTask: task || "Executing next task from PLAN.md",
		buildStatus: "in-progress",
	})

	async function* generateMessages(): AsyncGenerator<SDKUserMessage> {
		yield {
			type: "user" as const,
			session_id: "",
			parent_tool_use_id: null,
			message: {
				role: "user" as const,
				content: prompt,
			},
		}
	}

	const cfg = { ...DEFAULT_CODER_CONFIG, ...modelConfig }

	const queryOptions: Record<string, unknown> = {
		model: cfg.model,
		systemPrompt: coderPrompt,
		maxThinkingTokens: cfg.maxThinkingTokens,
		allowedTools: [
			"Read",
			"Write",
			"Edit",
			"Glob",
			"Grep",
			"Bash",
			"WebSearch",
			"mcp__electric-agent-tools__build",
			"mcp__electric-agent-tools__read_playbook",
			"mcp__electric-agent-tools__list_playbooks",
		],
		mcpServers: { "electric-agent-tools": mcpServer },
		hooks: createCoderHooks(projectDir),
		cwd: projectDir,
		maxTurns: cfg.maxTurns,
		maxBudgetUsd: cfg.maxBudgetUsd,
		permissionMode: "bypassPermissions",
		allowDangerouslySkipPermissions: true,
	}

	// Resume previous conversation if session ID is provided
	if (resumeSessionId) {
		queryOptions.resume = resumeSessionId
	}

	// Wire abort controller so cancellation stops the SDK agent
	if (abortController) {
		queryOptions.abortController = abortController
	}

	try {
		for await (const message of query({
			prompt: generateMessages(),
			options: queryOptions,
		})) {
			processAgentMessage(message, r)
			onMessage?.(message)

			// Capture session ID for potential resume
			const msgSessionId = (message as Record<string, unknown>).session_id as string | undefined
			if (msgSessionId) {
				sessionId = msgSessionId
			}

			// Handle result messages
			if (message.type === "result") {
				const sub = String(message.subtype)
				if (sub === "success") {
					stopReason = "complete"
				} else if (sub.includes("max_turns")) {
					stopReason = "max_turns"
					// Not a hard failure — work can be continued
				} else if (sub.includes("max_budget")) {
					stopReason = "max_budget"
					// Not a hard failure — user can increase budget and continue
				} else {
					stopReason = "error"
					success = false
					errors.push(sub)
				}
			}
		}
	} catch (err: unknown) {
		success = false
		stopReason = "error"
		const errMsg = err instanceof Error ? err.message : "Unknown error"
		errors.push(errMsg)

		logError(projectDir, {
			errorClass: "infrastructure",
			file: "agent",
			message: errMsg,
			attemptedFix: "none",
		})
	}

	// Check for consecutive identical failures
	if (consecutiveIdenticalFailures(projectDir)) {
		r.log("error", "Consecutive identical failures detected — escalation needed")
		await updateSession(projectDir, { buildStatus: "escalation-needed" })
	} else {
		await updateSession(projectDir, {
			buildStatus: success ? "passing" : "failing",
		})
	}

	return { success, errors, stopReason, sessionId }
}
