import readline from "node:readline"
import { createCliCallbacks } from "../engine/cli-adapter.js"
import { runNew } from "../engine/orchestrator.js"

async function promptDescription(): Promise<string> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	})

	console.log("\n  Describe the application you want to build.")
	console.log("  Type your description below. Press Enter on an empty line to finish.\n")

	return new Promise((resolve) => {
		const lines: string[] = []

		const askLine = () => {
			rl.question("> ", (line) => {
				if (line.trim() === "" && lines.length > 0) {
					rl.close()
					resolve(lines.join("\n"))
					return
				}
				if (line.trim() !== "") {
					lines.push(line)
				}
				askLine()
			})
		}

		askLine()
	})
}

export async function newCommand(opts: {
	name?: string
	approve?: boolean
	verbose?: boolean
}): Promise<void> {
	const description = await promptDescription()
	if (!description.trim()) {
		console.log("\x1b[31m[error]\x1b[0m No description provided")
		process.exit(1)
	}

	await runNew({
		description,
		projectName: opts.name,
		verbose: opts.verbose,
		autoApprove: opts.approve === false,
		callbacks: createCliCallbacks({ verbose: opts.verbose }),
	})
}
