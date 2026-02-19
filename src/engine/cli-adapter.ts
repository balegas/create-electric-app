import readline from "node:readline"
import { createProgressReporter, type ProgressReporter } from "../progress/reporter.js"
import type { EngineEvent, LogLevel } from "./events.js"
import type { OrchestratorCallbacks } from "./orchestrator.js"

const PREFIXES: Record<LogLevel, string> = {
	plan: "\x1b[36m[plan]\x1b[0m",
	approve: "\x1b[33m[approve]\x1b[0m",
	task: "\x1b[34m[task]\x1b[0m",
	build: "\x1b[35m[build]\x1b[0m",
	fix: "\x1b[33m[fix]\x1b[0m",
	done: "\x1b[32m[done]\x1b[0m",
	error: "\x1b[31m[error]\x1b[0m",
	verbose: "\x1b[2m[verbose]\x1b[0m",
}

/**
 * Map an EngineEvent to CLI console output.
 * Reproduces the exact same output the CLI had before the refactoring.
 */
function cliEventHandler(event: EngineEvent, verboseMode: boolean): void {
	switch (event.type) {
		case "log": {
			if (event.level === "verbose" && !verboseMode) return
			console.log(`${PREFIXES[event.level]} ${event.message}`)
			break
		}
		case "tool_start": {
			const prefix = "\x1b[2m"
			const reset = "\x1b[0m"
			const name = event.toolName
			if (name === "Write" || name === "Edit") {
				const filePath = (event.input.file_path || "unknown file") as string
				console.log(`${prefix}  ↳ ${name}: ${filePath}${reset}`)
			} else if (name === "Bash") {
				const cmd = ((event.input.command || "") as string).slice(0, 80)
				console.log(`${prefix}  ↳ Bash: ${cmd}${reset}`)
			} else if (name.includes("build")) {
				console.log(`${PREFIXES.build} Running build...`)
			} else if (name.includes("playbook")) {
				const playbook = (event.input.name || "read") as string
				console.log(`${prefix}  ↳ Playbook: ${playbook}${reset}`)
			}
			break
		}
		case "tool_result": {
			if (verboseMode) {
				console.log(`\x1b[2m[verbose]\x1b[0m [tool_result] ${event.output.slice(0, 1000)}`)
			}
			// Surface build results
			if (event.output.includes("=== pnpm run build ===")) {
				try {
					const result = JSON.parse(event.output) as {
						success?: boolean
						output?: string
						errors?: string
					}
					const output = result.output || ""
					const lines = output.split("\n").filter((l) => l.trim())
					const tail = lines.slice(-8).join("\n")
					if (!result.success) {
						console.log(`${PREFIXES.build} FAILED (${result.errors})`)
						console.log(`${PREFIXES.build} ${tail}`)
					} else {
						console.log(`${PREFIXES.build} Build passed`)
					}
				} catch {
					const lines = event.output.split("\n").filter((l) => l.trim())
					console.log(`${PREFIXES.build} ${lines.slice(-5).join("\n")}`)
				}
			}
			break
		}
		case "assistant_text": {
			if (verboseMode) {
				console.log(`\x1b[2m[verbose]\x1b[0m ${event.text}`)
			} else if (event.text.length > 10) {
				console.log(`${PREFIXES.task} ${event.text.slice(0, 200)}`)
			}
			break
		}
		case "assistant_thinking": {
			if (verboseMode) {
				console.log(`\x1b[2m[verbose]\x1b[0m [thinking] ${event.text.slice(0, 500)}`)
			}
			break
		}
		// Gate events are handled by the callbacks, not here
		case "clarification_needed":
		case "plan_ready":
		case "continue_needed":
		case "phase_complete":
		case "session_complete":
			break
	}
}

/**
 * Create OrchestratorCallbacks that use readline for CLI I/O.
 * This preserves the exact CLI behavior from before the refactoring.
 */
export function createCliCallbacks(opts?: { verbose?: boolean }): OrchestratorCallbacks {
	const verboseMode = opts?.verbose ?? false

	return {
		onEvent(event) {
			cliEventHandler(event, verboseMode)
		},

		async onClarificationNeeded(questions, summary) {
			if (summary) {
				console.log(`\n  Current understanding: ${summary}`)
			}
			console.log("\n  Please answer the following questions to help build a better plan:\n")

			const rl = readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			})
			const answers: string[] = []

			for (const [i, question] of questions.entries()) {
				const answer = await new Promise<string>((resolve) => {
					rl.question(`\n  ${i + 1}. ${question}\n  > `, (ans) => {
						resolve(ans.trim())
					})
				})
				answers.push(answer)
			}

			rl.close()
			return answers
		},

		async onPlanReady(plan) {
			console.log(`\n${plan}\n`)
			const rl = readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			})
			return new Promise((resolve) => {
				rl.question("\n[approve] Approve plan? (a)pprove / (r)evise / (c)ancel: ", (answer) => {
					rl.close()
					const a = answer.trim().toLowerCase()
					if (a === "a" || a === "approve") resolve("approve")
					else if (a === "r" || a === "revise") resolve("revise")
					else resolve("cancel")
				})
			})
		},

		async onRevisionRequested() {
			const rl = readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			})
			return new Promise((resolve) => {
				rl.question("[revise] What would you like to change? ", (answer) => {
					rl.close()
					resolve(answer.trim())
				})
			})
		},

		async onContinueNeeded() {
			const rl = readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			})
			return new Promise((resolve) => {
				rl.question(
					"\n[turns] Agent needs more turns to finish. Continue? (y)es / (n)o: ",
					(answer) => {
						rl.close()
						const a = answer.trim().toLowerCase()
						resolve(a === "y" || a === "yes" || a === "")
					},
				)
			})
		},
	}
}

/**
 * Create a ProgressReporter backed by CLI callbacks.
 * Used by components that still need a ProgressReporter interface (e.g., scaffold).
 */
export function createCliReporter(opts?: { verbose?: boolean }): ProgressReporter {
	return createProgressReporter(opts)
}
