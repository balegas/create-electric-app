import path from "node:path"
import fs from "node:fs"
import readline from "node:readline"
import { runCoder } from "../agents/coder.js"
import { readSession } from "../working-memory/session.js"
import { createProgressReporter } from "../progress/reporter.js"

export async function iterateCommand(): Promise<void> {
	const projectDir = process.cwd()
	const reporter = createProgressReporter()

	// Verify we're in a project directory
	if (!fs.existsSync(path.join(projectDir, "PLAN.md"))) {
		reporter.log("error", "Not in an Electric Agent project directory (no PLAN.md found)")
		reporter.log("error", "Run 'electric-agent new' to create a project first")
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
		const result = await runCoder(projectDir, userInput)

		if (result.success) {
			reporter.log("done", "Changes applied successfully")
		} else {
			reporter.log("error", `Issues: ${result.errors.join(", ")}`)
		}

		console.log()
	}
}
