import path from "node:path"
import readline from "node:readline"
import { runCoder } from "../agents/coder.js"
import { runPlanner } from "../agents/planner.js"
import { createProgressReporter } from "../progress/reporter.js"
import { scaffold } from "../scaffold/index.js"
import { validatePlaybooks } from "../tools/playbook.js"
import { updateSession } from "../working-memory/session.js"

function toKebabCase(str: string): string {
	return str
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50)
}

async function promptApproval(): Promise<"approve" | "revise" | "cancel"> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
	return new Promise((resolve) => {
		rl.question("\n[approve] Approve plan? (a)pprove / (r)evise / (c)ancel: ", (answer) => {
			rl.close()
			const a = answer.trim().toLowerCase()
			if (a === "a" || a === "approve") resolve("approve")
			else if (a === "r" || a === "revise") resolve("revise")
			else resolve("cancel")
		})
	})
}

async function promptRevision(): Promise<string> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
	return new Promise((resolve) => {
		rl.question("[revise] What would you like to change? ", (answer) => {
			rl.close()
			resolve(answer.trim())
		})
	})
}

async function promptContinue(): Promise<boolean> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
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
}

export async function newCommand(
	description: string,
	opts: { name?: string; approve?: boolean; debug?: boolean },
): Promise<void> {
	const projectName = opts.name || toKebabCase(description)
	const projectDir = path.resolve(process.cwd(), projectName)
	const reporter = createProgressReporter({ debug: opts.debug })

	reporter.log("plan", `Creating project: ${projectName}`)
	reporter.log("plan", `Description: ${description}`)

	// Step 1: Scaffold
	reporter.log("task", "Scaffolding project from KPB template...")
	const scaffoldResult = await scaffold(projectDir, { projectName, reporter })
	if (scaffoldResult.errors.length > 0) {
		for (const err of scaffoldResult.errors) {
			reporter.log("error", err)
		}
	}
	if (scaffoldResult.skippedInstall) {
		reporter.log("error", "Dependency install failed. You may need to run 'pnpm install' manually.")
	}
	reporter.log("done", "Scaffold complete")

	// Step 1b: Validate playbooks are installed
	try {
		validatePlaybooks(projectDir)
	} catch (e) {
		reporter.log("error", e instanceof Error ? e.message : "Playbook validation failed")
		process.exit(1)
	}

	// Step 2: Plan
	reporter.log("plan", "Running planner agent...")
	let plan = await runPlanner(description, projectDir, reporter)

	// Step 3: Approve
	if (opts.approve !== false) {
		console.log(`\n${plan}\n`)
		let decision = await promptApproval()

		while (decision === "revise") {
			const feedback = await promptRevision()
			reporter.log("plan", "Re-running planner with feedback...")
			plan = await runPlanner(
				`${description}\n\nRevision feedback: ${feedback}`,
				projectDir,
				reporter,
			)
			console.log(`\n${plan}\n`)
			decision = await promptApproval()
		}

		if (decision === "cancel") {
			reporter.log("error", "Cancelled by user")
			process.exit(1)
		}
	}

	// Step 4: Write plan and initialize session
	const fs = await import("node:fs/promises")
	await fs.writeFile(path.join(projectDir, "PLAN.md"), plan, "utf-8")
	await updateSession(projectDir, {
		appName: projectName,
		currentPhase: "generation",
		currentTask: "Starting code generation",
		buildStatus: "pending",
		totalBuilds: 0,
		totalErrors: 0,
		escalations: 0,
	})

	// Step 5: Run coder (with continuation on max turns)
	reporter.log("task", "Running coder agent...")
	let result = await runCoder(projectDir, undefined, reporter)

	while (result.stopReason === "max_turns") {
		reporter.log("task", "Agent reached turn limit but has more work to do")
		const shouldContinue = await promptContinue()
		if (!shouldContinue) {
			reporter.log("done", "Stopped by user. Run 'electric-agent iterate' to continue later.")
			return
		}
		reporter.log("task", "Continuing coder agent...")
		result = await runCoder(projectDir, undefined, reporter)
	}

	if (result.success) {
		reporter.log("done", `Project ${projectName} created successfully!`)
		reporter.log("done", `  cd ${projectName}`)
		reporter.log("done", "  electric-agent up")
	} else {
		reporter.log("error", `Generation completed with errors: ${result.errors.join(", ")}`)
		reporter.log("error", "Run 'electric-agent iterate' to continue fixing issues")
	}
}
