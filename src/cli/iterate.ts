import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { createCliCallbacks } from "../engine/cli-adapter.js"
import { runIterate } from "../engine/orchestrator.js"
import { validatePlaybooks } from "../tools/playbook.js"
import { readSession } from "../working-memory/session.js"

export async function iterateCommand(opts?: { debug?: boolean }): Promise<void> {
	const projectDir = process.cwd()

	// Verify we're in a project directory
	if (!fs.existsSync(path.join(projectDir, "PLAN.md"))) {
		console.log(
			"\x1b[31m[error]\x1b[0m Not in an Electric Agent project directory (no PLAN.md found)",
		)
		console.log("\x1b[31m[error]\x1b[0m Run 'electric-agent new' to create a project first")
		process.exit(1)
	}

	try {
		validatePlaybooks(projectDir)
	} catch (e) {
		console.log(
			`\x1b[31m[error]\x1b[0m ${e instanceof Error ? e.message : "Playbook validation failed"}`,
		)
		process.exit(1)
	}

	const session = await readSession(projectDir)
	console.log(`\x1b[34m[task]\x1b[0m Iterating on: ${session.appName || "project"}`)

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

	const prompt = (query: string): Promise<string> =>
		new Promise((resolve) => {
			rl.question(query, (answer) => resolve(answer.trim()))
		})

	console.log('\nEnter your changes (type "exit" to quit):\n')

	let lastSessionId: string | undefined

	while (true) {
		const userInput = await prompt("iterate> ")

		if (userInput === "exit" || userInput === "quit") {
			rl.close()
			console.log("\x1b[32m[done]\x1b[0m Session ended")
			break
		}

		if (!userInput) continue

		const callbacks = createCliCallbacks({ debug: opts?.debug })
		const result = await runIterate({
			projectDir,
			userRequest: userInput,
			debug: opts?.debug,
			callbacks,
			resumeSessionId: lastSessionId,
		})

		// Persist session ID so the next iteration has full conversation context
		if (result.sessionId) {
			lastSessionId = result.sessionId
		}

		if (!result.success) {
			// Errors already logged by the orchestrator
		}

		console.log()
	}
}
