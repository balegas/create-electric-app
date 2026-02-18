import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { evaluateDescription, inferProjectName } from "../agents/clarifier.js"
import { runCoder } from "../agents/coder.js"
import { runPlanner } from "../agents/planner.js"
import { createProgressReporter, type ProgressReporter } from "../progress/reporter.js"
import { scaffold } from "../scaffold/index.js"
import { validatePlaybooks } from "../tools/playbook.js"
import { updateSession } from "../working-memory/session.js"
import type { EngineEvent } from "./events.js"
import { ts } from "./events.js"
import { sdkMessageToEvents } from "./message-parser.js"

export interface OrchestratorCallbacks {
	onEvent: (event: EngineEvent) => void | Promise<void>

	// Gates — the orchestrator pauses until these resolve
	onClarificationNeeded: (questions: string[], summary: string) => Promise<string[]>
	onPlanReady: (plan: string) => Promise<"approve" | "revise" | "cancel">
	onRevisionRequested: () => Promise<string>
	onContinueNeeded: () => Promise<boolean>
}

/**
 * Check if the target directory already exists. If so, append a random 4-char hex suffix.
 */
export function resolveProjectDir(
	baseDir: string,
	name: string,
): { projectName: string; projectDir: string } {
	const candidate = path.resolve(baseDir, name)
	if (!fs.existsSync(candidate)) {
		return { projectName: name, projectDir: candidate }
	}
	const suffix = crypto.randomBytes(2).toString("hex")
	const uniqueName = `${name}-${suffix}`
	return { projectName: uniqueName, projectDir: path.resolve(baseDir, uniqueName) }
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

/**
 * Create an onMessage callback that parses SDK messages into EngineEvents.
 */
function createMessageForwarder(
	callbacks: OrchestratorCallbacks,
	reporter: ProgressReporter,
): (msg: Record<string, unknown>) => void {
	return (msg) => {
		const events = sdkMessageToEvents(msg, reporter.debugMode)
		for (const event of events) {
			callbacks.onEvent(event)
		}
	}
}

/**
 * Run the full "new project" flow.
 */
export async function runNew(opts: {
	description: string
	projectName?: string
	baseDir?: string
	debug?: boolean
	autoApprove?: boolean
	callbacks: OrchestratorCallbacks
}): Promise<void> {
	const { callbacks } = opts
	const emit = (event: EngineEvent) => callbacks.onEvent(event)
	const reporter = createReporterFromCallbacks(callbacks, opts.debug)

	// Step 0: Evaluate confidence and clarify if needed
	let description = opts.description
	emit({ type: "log", level: "plan", message: "Analyzing your description...", ts: ts() })

	try {
		const evaluation = await evaluateDescription(opts.description)

		if (evaluation.confidence < 70) {
			emit({
				type: "log",
				level: "plan",
				message: `Confidence: ${evaluation.confidence}% — need more details before planning`,
				ts: ts(),
			})

			emit({
				type: "clarification_needed",
				questions: evaluation.questions,
				confidence: evaluation.confidence,
				summary: evaluation.summary,
				ts: ts(),
			})

			const answers = await callbacks.onClarificationNeeded(
				evaluation.questions,
				evaluation.summary,
			)
			description = buildEnhancedDescription(opts.description, evaluation.questions, answers)
			emit({
				type: "log",
				level: "plan",
				message: "Description enriched with your answers",
				ts: ts(),
			})
		} else {
			emit({
				type: "log",
				level: "plan",
				message: `Confidence: ${evaluation.confidence}% — description is clear`,
				ts: ts(),
			})
		}
	} catch {
		emit({ type: "log", level: "plan", message: "Skipping clarification step", ts: ts() })
	}

	const inferredName = opts.projectName || (await inferProjectName(description))
	const baseDir = opts.baseDir || process.cwd()
	const { projectName, projectDir } = resolveProjectDir(baseDir, inferredName)

	emit({ type: "log", level: "plan", message: `Creating project: ${projectName}`, ts: ts() })
	emit({ type: "log", level: "plan", message: `Description: ${description}`, ts: ts() })

	// Step 1: Scaffold
	emit({
		type: "log",
		level: "task",
		message: "Scaffolding project from KPB template...",
		ts: ts(),
	})
	const scaffoldResult = await scaffold(projectDir, { projectName, reporter })
	if (scaffoldResult.errors.length > 0) {
		for (const err of scaffoldResult.errors) {
			emit({ type: "log", level: "error", message: err, ts: ts() })
		}
	}
	if (scaffoldResult.skippedInstall) {
		emit({
			type: "log",
			level: "error",
			message: "Dependency install failed. You may need to run 'pnpm install' manually.",
			ts: ts(),
		})
	}
	emit({ type: "log", level: "done", message: "Scaffold complete", ts: ts() })

	// Step 1b: Validate playbooks
	try {
		validatePlaybooks(projectDir)
	} catch (e) {
		emit({
			type: "log",
			level: "error",
			message: e instanceof Error ? e.message : "Playbook validation failed",
			ts: ts(),
		})
		emit({
			type: "phase_complete",
			phase: "scaffold",
			success: false,
			errors: ["Playbook validation failed"],
			ts: ts(),
		})
		return
	}

	// Step 2: Plan
	emit({ type: "log", level: "plan", message: "Running planner agent...", ts: ts() })
	const messageForwarder = createMessageForwarder(callbacks, reporter)
	let plan = await runPlanner(description, projectDir, reporter, messageForwarder)

	// Step 3: Approve
	if (!opts.autoApprove) {
		emit({ type: "plan_ready", plan, ts: ts() })
		let decision = await callbacks.onPlanReady(plan)

		while (decision === "revise") {
			const feedback = await callbacks.onRevisionRequested()
			emit({
				type: "log",
				level: "plan",
				message: "Re-running planner with feedback...",
				ts: ts(),
			})
			plan = await runPlanner(
				`${description}\n\nRevision feedback: ${feedback}`,
				projectDir,
				reporter,
				messageForwarder,
			)
			emit({ type: "plan_ready", plan, ts: ts() })
			decision = await callbacks.onPlanReady(plan)
		}

		if (decision === "cancel") {
			emit({ type: "log", level: "error", message: "Cancelled by user", ts: ts() })
			emit({
				type: "session_complete",
				success: false,
				ts: ts(),
			})
			return
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

	// Step 5: Run coder (with continuation on max turns / max budget)
	emit({ type: "log", level: "task", message: "Running coder agent...", ts: ts() })
	let result = await runCoder(projectDir, undefined, reporter, messageForwarder)

	while (result.stopReason === "max_turns" || result.stopReason === "max_budget") {
		emit({
			type: "continue_needed",
			reason: result.stopReason,
			ts: ts(),
		})
		const shouldContinue = await callbacks.onContinueNeeded()
		if (!shouldContinue) {
			emit({
				type: "log",
				level: "done",
				message: "Stopped by user. Run 'electric-agent iterate' to continue later.",
				ts: ts(),
			})
			emit({ type: "session_complete", success: true, ts: ts() })
			return
		}
		emit({ type: "log", level: "task", message: "Continuing coder agent...", ts: ts() })
		result = await runCoder(
			projectDir,
			"Continue where you left off. Keep working on the remaining unchecked tasks in PLAN.md.",
			reporter,
			messageForwarder,
			result.sessionId,
		)
	}

	if (result.success) {
		emit({
			type: "log",
			level: "done",
			message: `Project ${projectName} created successfully!`,
			ts: ts(),
		})
		emit({ type: "log", level: "done", message: `  cd ${projectName}`, ts: ts() })
		emit({ type: "log", level: "done", message: "  electric-agent up", ts: ts() })
	} else {
		emit({
			type: "log",
			level: "error",
			message: `Generation completed with errors: ${result.errors.join(", ")}`,
			ts: ts(),
		})
		emit({
			type: "log",
			level: "error",
			message: "Run 'electric-agent iterate' to continue fixing issues",
			ts: ts(),
		})
	}
	emit({
		type: "phase_complete",
		phase: "generation",
		success: result.success,
		errors: result.errors,
		ts: ts(),
	})
	emit({ type: "session_complete", success: result.success, ts: ts() })
}

/**
 * Run a single iteration on an existing project.
 */
export async function runIterate(opts: {
	projectDir: string
	userRequest: string
	debug?: boolean
	callbacks: OrchestratorCallbacks
}): Promise<{ success: boolean; errors: string[] }> {
	const { callbacks, projectDir, userRequest } = opts
	const emit = (event: EngineEvent) => callbacks.onEvent(event)
	const reporter = createReporterFromCallbacks(callbacks, opts.debug)
	const messageForwarder = createMessageForwarder(callbacks, reporter)

	const iterationPrompt = `The user wants the following change to the existing app:

${userRequest}

Instructions:
1. Read PLAN.md and the current codebase to understand the existing app
2. Read relevant playbooks before coding (use list_playbooks, then read what you need):
   - UI changes → read "live-queries" playbook (covers useLiveQuery + SSR rules)
   - Schema changes → read "schemas" and "electric-quickstart"
   - Collection/mutation changes → read "collections" and "mutations"
3. Add a new "## Iteration: ${userRequest.slice(0, 60)}" section to the bottom of PLAN.md with tasks for this change
4. Implement the changes immediately — write the actual code, following the Drizzle Workflow order
5. If schema changes are needed, run drizzle-kit generate && drizzle-kit migrate
6. Mark tasks as done in PLAN.md after completing them
7. Run the build tool to verify everything compiles

CRITICAL reminders:
- Components using useLiveQuery MUST NOT be rendered directly in __root.tsx — wrap with ClientOnly
- Leaf routes using useLiveQuery need ssr: false
- Mutation routes must use parseDates(await request.json())

Do NOT just write a plan — implement the changes directly.`

	emit({ type: "log", level: "task", message: "Running coder with your request...", ts: ts() })
	let result = await runCoder(projectDir, iterationPrompt, reporter, messageForwarder)

	while (result.stopReason === "max_turns" || result.stopReason === "max_budget") {
		emit({ type: "continue_needed", reason: result.stopReason, ts: ts() })
		const shouldContinue = await callbacks.onContinueNeeded()
		if (!shouldContinue) {
			emit({
				type: "log",
				level: "done",
				message: "Paused. You can continue this work in the next iteration.",
				ts: ts(),
			})
			return { success: true, errors: [] }
		}
		emit({ type: "log", level: "task", message: "Continuing coder agent...", ts: ts() })
		result = await runCoder(
			projectDir,
			"Continue where you left off. Keep implementing the remaining changes.",
			reporter,
			messageForwarder,
			result.sessionId,
		)
	}

	if (result.success) {
		emit({ type: "log", level: "done", message: "Changes applied successfully", ts: ts() })
	} else {
		emit({
			type: "log",
			level: "error",
			message: `Issues: ${result.errors.join(", ")}`,
			ts: ts(),
		})
	}

	return { success: result.success, errors: result.errors }
}

/**
 * Create a ProgressReporter that works for both CLI and web by forwarding to the engine callback.
 * The reporter is used by scaffold and other components that need it directly.
 */
function createReporterFromCallbacks(
	_callbacks: OrchestratorCallbacks,
	debug?: boolean,
): ProgressReporter {
	return createProgressReporter({ debug })
}
