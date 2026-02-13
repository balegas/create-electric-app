import path from "node:path"
import readline from "node:readline"
import { evaluateDescription } from "../agents/clarifier.js"
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

async function promptClarificationAnswers(questions: string[]): Promise<string[]> {
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
}

function buildEnhancedDescription(
	original: string,
	questions: string[],
	answers: string[],
): string {
	let enhanced = original
	if (questions.length > 0) {
		enhanced += "\n\nAdditional details:"
		for (let i = 0; i < questions.length; i++) {
			if (answers[i]) {
				enhanced += `\n- ${questions[i]} ${answers[i]}`
			}
		}
	}
	return enhanced
}

async function promptApproval(): Promise<"approve" | "revise" | "cancel"> {
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
}

async function promptRevision(): Promise<string> {
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
}

async function promptContinue(): Promise<boolean> {
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
}

export async function newCommand(opts: {
	name?: string
	approve?: boolean
	debug?: boolean
}): Promise<void> {
	const reporter = createProgressReporter({ debug: opts.debug })

	// Step 0: Get description interactively
	const rawDescription = await promptDescription()
	if (!rawDescription.trim()) {
		reporter.log("error", "No description provided")
		process.exit(1)
	}

	// Step 0b: Evaluate confidence and clarify if needed
	let description = rawDescription
	reporter.log("plan", "Analyzing your description...")
	try {
		const evaluation = await evaluateDescription(rawDescription)

		if (evaluation.confidence < 70) {
			reporter.log(
				"plan",
				`Confidence: ${evaluation.confidence}% — need more details before planning`,
			)
			if (evaluation.summary) {
				console.log(`\n  Current understanding: ${evaluation.summary}`)
			}
			console.log("\n  Please answer the following questions to help build a better plan:\n")
			const answers = await promptClarificationAnswers(evaluation.questions)
			description = buildEnhancedDescription(rawDescription, evaluation.questions, answers)
			reporter.log("plan", "Description enriched with your answers")
		} else {
			reporter.log("plan", `Confidence: ${evaluation.confidence}% — description is clear`)
		}
	} catch {
		reporter.log("plan", "Skipping clarification step")
	}

	const projectName = opts.name || toKebabCase(rawDescription.split("\n")[0])
	const projectDir = path.resolve(process.cwd(), projectName)

	reporter.log("plan", `Creating project: ${projectName}`)
	reporter.log("plan", `Description: ${description}`)

	// Step 1: Scaffold
	reporter.log("task", "Scaffolding project from KPB template...")
	const scaffoldResult = await scaffold(projectDir, {
		projectName,
		reporter,
	})
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
