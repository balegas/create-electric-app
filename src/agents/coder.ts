import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { hooks as guardrailHooks } from "../hooks/index.js"
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
}

/**
 * Run the coder agent to execute tasks from PLAN.md.
 */
export async function runCoder(
	projectDir: string,
	task?: string,
	reporter?: ProgressReporter,
	onMessage?: (msg: Record<string, unknown>) => void,
): Promise<CoderResult> {
	const r = reporter ?? createProgressReporter()
	const coderPrompt = buildCoderPrompt(projectDir)
	const mcpServer = createToolServer(projectDir, r)
	const errors: string[] = []
	let success = true
	let stopReason: StopReason = "complete"

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

	try {
		for await (const message of query({
			prompt: generateMessages(),
			options: {
				model: "claude-sonnet-4-5-20250929",
				systemPrompt: coderPrompt,
				maxThinkingTokens: 8192,
				allowedTools: [
					"Read",
					"Write",
					"Edit",
					"Glob",
					"Grep",
					"Bash",
					"mcp__electric-agent-tools__build",
					"mcp__electric-agent-tools__read_playbook",
					"mcp__electric-agent-tools__list_playbooks",
				],
				mcpServers: { "electric-agent-tools": mcpServer },
				hooks: guardrailHooks,
				cwd: projectDir,
				maxTurns: 60,
				maxBudgetUsd: 5.0,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
			},
		})) {
			processAgentMessage(message, r)
			onMessage?.(message)

			// Check for build failures in tool results
			if (message.type === "assistant" && message.message?.content) {
				for (const block of message.message.content) {
					if ("name" in block && (block.name as string)?.includes("build")) {
						// Build tool was called — check result in next message
					}
				}
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
					success = false
					errors.push("Budget limit reached")
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

	return { success, errors, stopReason }
}
