import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { runCoder } from "../agents/coder.js"
import { createProgressReporter } from "../progress/reporter.js"
import { validatePlaybooks } from "../tools/playbook.js"
import { readSession } from "../working-memory/session.js"

function promptContinue(rl: readline.Interface): Promise<boolean> {
	return new Promise((resolve) => {
		rl.question(
			"\n[turns] Agent needs more turns to finish. Continue? (y)es / (n)o: ",
			(answer) => {
				const a = answer.trim().toLowerCase()
				resolve(a === "y" || a === "yes" || a === "")
			},
		)
	})
}

export async function iterateCommand(opts?: { debug?: boolean }): Promise<void> {
	const projectDir = process.cwd()
	const reporter = createProgressReporter({ debug: opts?.debug })

	// Verify we're in a project directory
	if (!fs.existsSync(path.join(projectDir, "PLAN.md"))) {
		reporter.log("error", "Not in an Electric Agent project directory (no PLAN.md found)")
		reporter.log("error", "Run 'electric-agent new' to create a project first")
		process.exit(1)
	}

	try {
		validatePlaybooks(projectDir)
	} catch (e) {
		reporter.log("error", e instanceof Error ? e.message : "Playbook validation failed")
		process.exit(1)
	}

	const session = await readSession(projectDir)
	reporter.log("task", `Iterating on: ${session.appName || "project"}`)

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

	const prompt = (query: string): Promise<string> =>
		new Promise((resolve) => {
			rl.question(query, (answer) => resolve(answer.trim()))
		})

	console.log('\nEnter your changes (type "exit" to quit):\n')

	while (true) {
		const userInput = await prompt("iterate> ")

		if (userInput === "exit" || userInput === "quit") {
			rl.close()
			reporter.log("done", "Session ended")
			break
		}

		if (!userInput) continue

		reporter.log("task", "Running coder with your request...")
		let result = await runCoder(projectDir, userInput, reporter)
		let userDeclined = false

		while (result.stopReason === "max_turns") {
			reporter.log("task", "Agent reached turn limit but has more work to do")
			const shouldContinue = await promptContinue(rl)
			if (!shouldContinue) {
				userDeclined = true
				break
			}
			reporter.log("task", "Continuing coder agent...")
			result = await runCoder(projectDir, `Continue the previous task: ${userInput}`, reporter)
		}

		if (userDeclined) {
			reporter.log("done", "Paused. You can continue this work in the next iteration.")
		} else if (result.success) {
			reporter.log("done", "Changes applied successfully")
		} else {
			reporter.log("error", `Issues: ${result.errors.join(", ")}`)
		}

		console.log()
	}
}
