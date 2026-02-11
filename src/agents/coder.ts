import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { buildCoderPrompt } from "./prompts.js"
import { createToolServer } from "../tools/server.js"
import { hooks as guardrailHooks } from "../hooks/index.js"
import { createProgressReporter, processAgentMessage } from "../progress/reporter.js"
import { updateSession } from "../working-memory/session.js"
import { logError, consecutiveIdenticalFailures } from "../working-memory/errors.js"

export interface CoderResult {
	success: boolean
	errors: string[]
}

/**
 * Run the coder agent to execute tasks from PLAN.md.
 */
export async function runCoder(
	projectDir: string,
	task?: string,
): Promise<CoderResult> {
	const reporter = createProgressReporter()
	const coderPrompt = buildCoderPrompt(projectDir)
	const mcpServer = createToolServer()
	const errors: string[] = []
	let success = true

	const prompt = task || "Read PLAN.md and execute the next unchecked task. After completing each task, mark it as done with [x] in PLAN.md. Run the build tool after each significant change to verify the code compiles."

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
				maxTurns: 30,
				maxBudgetUsd: 2.0,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
			},
		})) {
			processAgentMessage(message, reporter)

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
				if (message.subtype !== "success") {
					success = false
					errors.push(message.subtype)
				}
			}
		}
	} catch (err: any) {
		success = false
		errors.push(err.message || "Unknown error")

		logError(projectDir, {
			errorClass: "infrastructure",
			file: "agent",
			message: err.message || "Agent execution failed",
			attemptedFix: "none",
		})
	}

	// Check for consecutive identical failures
	if (consecutiveIdenticalFailures(projectDir)) {
		reporter.log("error", "Consecutive identical failures detected — escalation needed")
		await updateSession(projectDir, { buildStatus: "escalation-needed" })
	} else {
		await updateSession(projectDir, {
			buildStatus: success ? "passing" : "failing",
		})
	}

	return { success, errors }
}
