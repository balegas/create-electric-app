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
		const iterationPrompt = `The user wants the following change to the existing app:

${userInput}

Instructions:
1. Read PLAN.md and the current codebase to understand the existing app
2. Read relevant playbooks before coding (use list_playbooks, then read what you need):
   - UI changes → read "live-queries" playbook (covers useLiveQuery + SSR rules)
   - Schema changes → read "schemas" and "electric-quickstart"
   - Collection/mutation changes → read "collections" and "mutations"
3. Add a new "## Iteration: ${userInput.slice(0, 60)}" section to the bottom of PLAN.md with tasks for this change
4. Implement the changes immediately — write the actual code, following the Drizzle Workflow order
5. If schema changes are needed, run drizzle-kit generate && drizzle-kit migrate
6. Mark tasks as done in PLAN.md after completing them
7. Run the build tool to verify everything compiles

CRITICAL reminders:
- Components using useLiveQuery MUST NOT be rendered directly in __root.tsx — wrap with ClientOnly
- Leaf routes using useLiveQuery need ssr: false
- Mutation routes must use parseDates(await request.json())

Do NOT just write a plan — implement the changes directly.`
		let result = await runCoder(projectDir, iterationPrompt, reporter)
		let userDeclined = false

		while (result.stopReason === "max_turns") {
			reporter.log("task", "Agent reached turn limit but has more work to do")
			const shouldContinue = await promptContinue(rl)
			if (!shouldContinue) {
				userDeclined = true
				break
			}
			reporter.log("task", "Continuing coder agent...")
			result = await runCoder(
				projectDir,
				`Continue implementing the previous request: ${userInput}\nRead PLAN.md to see what tasks remain unchecked, then implement them. Do NOT just plan — write code.`,
				reporter,
			)
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
