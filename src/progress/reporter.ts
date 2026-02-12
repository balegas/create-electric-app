type LogLevel = "plan" | "approve" | "task" | "build" | "fix" | "done" | "error" | "debug"

const PREFIXES: Record<LogLevel, string> = {
	plan: "\x1b[36m[plan]\x1b[0m",
	approve: "\x1b[33m[approve]\x1b[0m",
	task: "\x1b[34m[task]\x1b[0m",
	build: "\x1b[35m[build]\x1b[0m",
	fix: "\x1b[33m[fix]\x1b[0m",
	done: "\x1b[32m[done]\x1b[0m",
	error: "\x1b[31m[error]\x1b[0m",
	debug: "\x1b[2m[debug]\x1b[0m",
}

export interface ProgressReporter {
	log(level: LogLevel, message: string): void
	logToolUse(toolName: string, summary: string): void
	debugMode: boolean
}

export function createProgressReporter(opts?: { debug?: boolean }): ProgressReporter {
	const debugMode = opts?.debug ?? false
	return {
		debugMode,

		log(level: LogLevel, message: string) {
			if (level === "debug" && !debugMode) return
			console.log(`${PREFIXES[level]} ${message}`)
		},

		logToolUse(toolName: string, summary: string) {
			const prefix = "\x1b[2m"
			const reset = "\x1b[0m"
			console.log(`${prefix}  ↳ ${toolName}: ${summary}${reset}`)
		},
	}
}

/**
 * Process SDK messages and route them to the progress reporter.
 */
export function processAgentMessage(
	message: Record<string, unknown>,
	reporter: ProgressReporter,
): void {
	if (message.type === "assistant" && (message.message as Record<string, unknown>)?.content) {
		const content = (message.message as Record<string, unknown>).content as Record<
			string,
			unknown
		>[]
		for (const block of content) {
			if ("text" in block && block.text) {
				const text = block.text as string
				if (reporter.debugMode) {
					reporter.log("debug", text)
				} else if (text.length > 10) {
					reporter.log("task", text.slice(0, 200))
				}
			} else if ("thinking" in block && block.thinking && reporter.debugMode) {
				const thinking = block.thinking as string
				reporter.log("debug", `[thinking] ${thinking.slice(0, 500)}`)
			} else if ("name" in block) {
				const name = block.name as string
				const input = (block.input || {}) as Record<string, unknown>

				if (name === "Write" || name === "Edit") {
					reporter.logToolUse(name, (input.file_path || "unknown file") as string)
				} else if (name === "Bash") {
					const cmd = (input.command || "") as string
					reporter.logToolUse("Bash", cmd.slice(0, 80))
				} else if (name.includes("build")) {
					reporter.log("build", "Running build...")
				} else if (name.includes("playbook")) {
					reporter.logToolUse("Playbook", (input.name || "read") as string)
				}
			}
		}
	} else if (message.type === "tool_result" && reporter.debugMode) {
		const content = (message as Record<string, unknown>).content
		if (typeof content === "string") {
			reporter.log("debug", `[tool_result] ${content.slice(0, 1000)}`)
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (typeof block === "object" && block && "text" in block) {
					reporter.log("debug", `[tool_result] ${(block.text as string).slice(0, 1000)}`)
				}
			}
		}
	} else if (message.type === "result") {
		const sub = String(message.subtype)
		const cost = message.total_cost_usd as number | undefined
		const costStr = `(cost: $${cost?.toFixed(4) || "?"})`
		if (sub === "success") {
			reporter.log("done", `Agent completed ${costStr}`)
		} else if (sub.includes("max_turns")) {
			reporter.log("task", `Agent reached turn limit ${costStr}`)
		} else {
			reporter.log("error", `Agent stopped: ${sub} ${costStr}`)
		}
	}
}
