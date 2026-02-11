type LogLevel = "plan" | "approve" | "task" | "build" | "fix" | "done" | "error"

const PREFIXES: Record<LogLevel, string> = {
	plan: "\x1b[36m[plan]\x1b[0m",
	approve: "\x1b[33m[approve]\x1b[0m",
	task: "\x1b[34m[task]\x1b[0m",
	build: "\x1b[35m[build]\x1b[0m",
	fix: "\x1b[33m[fix]\x1b[0m",
	done: "\x1b[32m[done]\x1b[0m",
	error: "\x1b[31m[error]\x1b[0m",
}

export interface ProgressReporter {
	log(level: LogLevel, message: string): void
	logToolUse(toolName: string, summary: string): void
}

export function createProgressReporter(): ProgressReporter {
	return {
		log(level: LogLevel, message: string) {
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
	message: any,
	reporter: ProgressReporter,
): void {
	if (message.type === "assistant" && message.message?.content) {
		for (const block of message.message.content) {
			if ("text" in block && block.text) {
				// Only show substantive text, not thinking
				const text = block.text as string
				if (text.length > 10) {
					reporter.log("task", text.slice(0, 200))
				}
			} else if ("name" in block) {
				const name = block.name as string
				const input = (block as any).input || {}

				// Summarize common tool uses
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
	} else if (message.type === "result") {
		if (message.subtype === "success") {
			reporter.log("done", `Agent completed (cost: $${message.total_cost_usd?.toFixed(4) || "?"})`)
		} else {
			reporter.log("error", `Agent stopped: ${message.subtype}`)
		}
	}
}
