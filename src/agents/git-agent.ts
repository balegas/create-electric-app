import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { createGitToolServer } from "../tools/git-server.js"
import { buildGitAgentPrompt } from "./prompts.js"

export interface GitAgentResult {
	success: boolean
	output: string
	commitHash?: string
	repoUrl?: string
	prUrl?: string
}

function extractToolResults(message: Record<string, unknown>): Record<string, unknown>[] {
	const results: Record<string, unknown>[] = []
	// SDK sends tool results as user messages with tool_result content blocks
	if (message.type === "user") {
		const msgContent = (message.message as Record<string, unknown>)?.content
		if (Array.isArray(msgContent)) {
			for (const block of msgContent) {
				if (
					typeof block === "object" &&
					block &&
					(block as Record<string, unknown>).type === "tool_result"
				) {
					const content = (block as Record<string, unknown>).content
					if (Array.isArray(content)) {
						for (const part of content) {
							if (
								typeof part === "object" &&
								part &&
								(part as Record<string, unknown>).type === "text"
							) {
								try {
									results.push(JSON.parse((part as Record<string, string>).text))
								} catch {
									// Not JSON
								}
							}
						}
					} else if (typeof content === "string") {
						try {
							results.push(JSON.parse(content))
						} catch {
							// Not JSON
						}
					}
				}
			}
		}
	}
	return results
}

export async function runGitAgent(opts: {
	projectDir: string
	task: string
	onMessage?: (msg: Record<string, unknown>) => void
}): Promise<GitAgentResult> {
	const { projectDir, task, onMessage } = opts
	const systemPrompt = buildGitAgentPrompt(projectDir)
	const mcpServer = createGitToolServer(projectDir)

	let success = true
	let output = ""
	let commitHash: string | undefined
	let repoUrl: string | undefined
	let prUrl: string | undefined

	async function* generateMessages(): AsyncGenerator<SDKUserMessage> {
		yield {
			type: "user" as const,
			session_id: "",
			parent_tool_use_id: null,
			message: {
				role: "user" as const,
				content: task,
			},
		}
	}

	try {
		for await (const message of query({
			prompt: generateMessages(),
			options: {
				model: "claude-haiku-4-5-20251001",
				systemPrompt,
				allowedTools: [
					"mcp__git-tools__git_status",
					"mcp__git-tools__git_diff_summary",
					"mcp__git-tools__git_diff",
					"mcp__git-tools__git_commit",
					"mcp__git-tools__git_init",
					"mcp__git-tools__git_push",
					"mcp__git-tools__gh_repo_create",
					"mcp__git-tools__gh_pr_create",
					"mcp__git-tools__git_checkout",
				],
				mcpServers: { "git-tools": mcpServer },
				maxTurns: 5,
				maxBudgetUsd: 0.25,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
			} as Record<string, unknown>,
		})) {
			onMessage?.(message as Record<string, unknown>)

			// Extract text output from assistant messages
			if (message.type === "assistant") {
				const content = (message as Record<string, unknown>).message as
					| { content?: Array<{ type: string; text?: string }> }
					| undefined
				if (content?.content) {
					for (const block of content.content) {
						if (block.type === "text" && block.text) {
							output += block.text
						}
					}
				}
			}

			// Extract structured results from tool result messages
			const toolResults = extractToolResults(message as Record<string, unknown>)
			for (const parsed of toolResults) {
				if (parsed.commitHash) commitHash = parsed.commitHash as string
				if (parsed.repoUrl) repoUrl = parsed.repoUrl as string
				if (parsed.prUrl) prUrl = parsed.prUrl as string
			}

			if (message.type === "result") {
				const sub = String((message as Record<string, unknown>).subtype)
				if (sub !== "success" && !sub.includes("max_turns") && !sub.includes("max_budget")) {
					success = false
				}
			}
		}
	} catch (err) {
		success = false
		output = err instanceof Error ? err.message : "Git agent failed"
	}

	return { success, output, commitHash, repoUrl, prUrl }
}
