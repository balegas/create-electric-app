import { execSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { EngineEvent } from "@electric-agent/protocol"
import { ts } from "@electric-agent/protocol"
import { evaluateDescription, inferProjectName } from "../agents/clarifier.js"
import { runCoder } from "../agents/coder.js"
import { runPlanner } from "../agents/planner.js"
import { createProgressReporter, type ProgressReporter } from "../progress/reporter.js"
import { scaffold } from "../scaffold/index.js"
import { validatePlaybooks } from "../tools/playbook.js"
import { updateSession } from "../working-memory/session.js"
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
	// Extra free-text answer beyond the numbered questions
	const extra = answers[questions.length]
	if (extra) {
		enhanced += `\n\nExtra context from the user:\n${extra}`
	}
	return enhanced
}

/**
 * Create an onMessage callback that parses SDK messages into EngineEvents.
 */
function createMessageForwarder(
	callbacks: OrchestratorCallbacks,
	agent?: string,
): (msg: Record<string, unknown>) => void {
	return (msg) => {
		const events = sdkMessageToEvents(msg, agent)
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
	verbose?: boolean
	autoApprove?: boolean
	initGit?: boolean
	callbacks: OrchestratorCallbacks
	abortController?: AbortController
	/** If provided, create a GitHub repo and push the scaffold before planning */
	gitRepoName?: string
	gitRepoVisibility?: "public" | "private"
}): Promise<{ sessionId?: string; projectDir?: string }> {
	const { callbacks } = opts
	const emit = (event: EngineEvent) => callbacks.onEvent(event)
	const reporter = createReporterFromCallbacks(callbacks, opts.verbose)

	// Step 0: Evaluate confidence, clarify if needed, and infer project name
	// Run evaluation and name inference in parallel to save time
	let description = opts.description
	let inferredName = opts.projectName || ""
	emit({ type: "log", level: "plan", message: "Analyzing your description...", ts: ts() })

	try {
		// Run evaluation and name inference concurrently — both use the original description
		const [evaluation, earlyName] = await Promise.all([
			evaluateDescription(opts.description),
			inferredName || inferProjectName(opts.description),
		])
		if (!inferredName) inferredName = earlyName

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
		if (!inferredName) inferredName = await inferProjectName(description)
	}

	const baseDir = opts.baseDir || process.cwd()
	// When the caller provides an explicit projectName (e.g. server/sandbox),
	// use it as-is — no dedup suffix. A sprite has exactly one project, and
	// the server-sent name is used for the GitHub repo. Only add entropy
	// when the name was inferred and might collide on a developer's machine.
	const { projectName, projectDir } = opts.projectName
		? { projectName: inferredName, projectDir: path.resolve(baseDir, inferredName) }
		: resolveProjectDir(baseDir, inferredName)

	emit({ type: "log", level: "plan", message: `Creating project: ${projectName}`, ts: ts() })
	emit({ type: "log", level: "plan", message: `Description: ${description}`, ts: ts() })

	// Step 1: Scaffold
	emit({
		type: "log",
		level: "task",
		message: "Scaffolding project from KPB template...",
		ts: ts(),
	})
	const skipGit = opts.initGit === false
	const scaffoldResult = await scaffold(projectDir, { projectName, reporter, skipGit })
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

	// Validate critical project structure before proceeding to planner/coder
	const pkgExists = fs.existsSync(path.join(projectDir, "package.json"))
	if (!pkgExists) {
		emit({
			type: "log",
			level: "error",
			message: "Critical: package.json missing after scaffold — cannot proceed",
			ts: ts(),
		})
		emit({
			type: "phase_complete",
			phase: "scaffold",
			success: false,
			errors: ["package.json missing after scaffold"],
			ts: ts(),
		})
		return { projectDir }
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
		return { projectDir }
	}

	// Step 1c: Create GitHub repo and push scaffold (if repo config provided)
	if (opts.gitRepoName) {
		emit({
			type: "log",
			level: "task",
			message: "Creating GitHub repo and pushing scaffold...",
			ts: ts(),
		})
		gitAutoCommit(projectDir, "chore: initial scaffold", emit)
		try {
			const vis = opts.gitRepoVisibility || "private"
			execSync(`gh repo create "${opts.gitRepoName}" --${vis} --source . --remote origin --push`, {
				cwd: projectDir,
				stdio: "pipe",
				timeout: 60_000,
				env: { ...process.env },
			})
			emit({
				type: "log",
				level: "done",
				message: `GitHub repo created: ${opts.gitRepoName} (${vis})`,
				ts: ts(),
			})
		} catch (err) {
			const msg = err instanceof Error ? err.message : "unknown error"
			emit({ type: "log", level: "error", message: `Repo creation failed: ${msg}`, ts: ts() })
			emit({ type: "session_end", success: false, ts: ts() })
			return { projectDir }
		}
	}

	// Step 2: Plan
	emit({ type: "log", level: "plan", message: "Running planner agent...", ts: ts() })
	const plannerForwarder = createMessageForwarder(callbacks, "planner")
	let plan = await runPlanner(
		description,
		projectDir,
		reporter,
		plannerForwarder,
		opts.abortController,
	)

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
				plannerForwarder,
				opts.abortController,
			)
			emit({ type: "plan_ready", plan, ts: ts() })
			decision = await callbacks.onPlanReady(plan)
		}

		if (decision === "cancel") {
			emit({ type: "log", level: "error", message: "Cancelled by user", ts: ts() })
			emit({
				type: "session_end",
				success: false,
				ts: ts(),
			})
			return { projectDir }
		}
	}

	// Step 4: Write plan and initialize session (parallel — independent operations)
	const fsPromises = await import("node:fs/promises")
	await Promise.all([
		fsPromises.writeFile(path.join(projectDir, "PLAN.md"), plan, "utf-8"),
		updateSession(projectDir, {
			appName: projectName,
			currentPhase: "generation",
			currentTask: "Starting code generation",
			buildStatus: "pending",
			totalBuilds: 0,
			totalErrors: 0,
			escalations: 0,
		}),
	])

	// Step 5: Run coder (with continuation on max turns / max budget)
	emit({ type: "log", level: "task", message: "Running coder agent...", ts: ts() })
	const coderForwarder = createMessageForwarder(callbacks, "coder")
	let result = await runCoder(
		projectDir,
		undefined,
		reporter,
		coderForwarder,
		undefined,
		opts.abortController,
	)

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
			emit({ type: "session_end", success: true, ts: ts() })
			return { sessionId: result.sessionId, projectDir }
		}
		emit({ type: "log", level: "task", message: "Continuing coder agent...", ts: ts() })
		result = await runCoder(
			projectDir,
			"Continue where you left off. Keep working on the remaining unchecked tasks in PLAN.md.",
			reporter,
			coderForwarder,
			result.sessionId,
			opts.abortController,
		)
	}

	if (result.success) {
		// Auto-commit after successful generation
		emit({ type: "log", level: "task", message: "Creating git commit...", ts: ts() })
		const commitResult = gitAutoCommit(projectDir, "feat: initial app generation", emit)
		if (commitResult) {
			emit({
				type: "git_checkpoint",
				commitHash: commitResult,
				message: "feat: initial app generation",
				ts: ts(),
			})
			// Push to remote if one exists (e.g. repo was created during scaffold)
			gitAutoPush(projectDir, emit)
		}

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
	emit({ type: "session_end", success: result.success, ts: ts() })
	return { sessionId: result.sessionId, projectDir }
}

/**
 * Run a single iteration on an existing project.
 */
export async function runIterate(opts: {
	projectDir: string
	userRequest: string
	verbose?: boolean
	callbacks: OrchestratorCallbacks
	abortController?: AbortController
	resumeSessionId?: string
}): Promise<{ success: boolean; errors: string[]; sessionId?: string }> {
	const { callbacks, projectDir, userRequest } = opts
	const emit = (event: EngineEvent) => callbacks.onEvent(event)
	const reporter = createReporterFromCallbacks(callbacks, opts.verbose)
	const messageForwarder = createMessageForwarder(callbacks, "coder")

	const iterationPrompt = `The user wants the following change to the existing app:

${userRequest}

Instructions:
1. Consult ARCHITECTURE.md (injected into your context as <app-architecture>) to understand the app structure — do NOT scan the filesystem
2. Read PLAN.md to see what was built and previous iterations
3. Read "electric-app-guardrails" playbook FIRST for critical integration rules
4. Use list_playbooks to discover relevant skills, then read only what you need for this change
5. Add a new "## Iteration: ${userRequest.slice(0, 60)}" section to the bottom of PLAN.md with tasks for this change
6. Read ONLY the specific source files you need to modify (consult ARCHITECTURE.md for exact paths)
7. Implement the changes immediately — write the actual code, following the Drizzle Workflow order
8. If schema changes are needed, run drizzle-kit generate && drizzle-kit migrate
9. Mark tasks as done in PLAN.md after completing them
10. Update ARCHITECTURE.md to reflect any changes (new entities, routes, components, styles, or contexts)
11. Run the build tool ONCE after all changes are complete — not after each file

Do NOT just write a plan — implement the changes directly.`

	emit({ type: "log", level: "task", message: "Running coder with your request...", ts: ts() })
	let result = await runCoder(
		projectDir,
		iterationPrompt,
		reporter,
		messageForwarder,
		opts.resumeSessionId,
		opts.abortController,
	)

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
			return { success: true, errors: [], sessionId: result.sessionId }
		}
		emit({ type: "log", level: "task", message: "Continuing coder agent...", ts: ts() })
		result = await runCoder(
			projectDir,
			"Continue where you left off. Keep implementing the remaining changes.",
			reporter,
			messageForwarder,
			result.sessionId,
			opts.abortController,
		)
	}

	if (result.success) {
		// Auto-commit after successful iteration
		emit({ type: "log", level: "task", message: "Creating git commit...", ts: ts() })
		const commitMsg = `feat: ${userRequest.slice(0, 70)}`
		const commitResult = gitAutoCommit(projectDir, commitMsg, emit)
		if (commitResult) {
			emit({
				type: "git_checkpoint",
				commitHash: commitResult,
				message: commitMsg,
				ts: ts(),
			})
		}

		emit({ type: "log", level: "done", message: "Changes applied successfully", ts: ts() })
	} else {
		emit({
			type: "log",
			level: "error",
			message: `Issues: ${result.errors.join(", ")}`,
			ts: ts(),
		})
	}

	return { success: result.success, errors: result.errors, sessionId: result.sessionId }
}

/**
 * Stage all changes and commit. Returns the commit hash, or null if there were no changes.
 */
function gitAutoCommit(
	projectDir: string,
	message: string,
	emit: (event: EngineEvent) => void | Promise<void>,
): string | null {
	// Check for .git directory before attempting git operations
	if (!fs.existsSync(path.join(projectDir, ".git"))) {
		emit({
			type: "log",
			level: "error",
			message:
				"Skipping git commit — no .git directory found (git init may have failed during scaffold)",
			ts: ts(),
		})
		return null
	}

	try {
		execSync("git add -A", { cwd: projectDir, stdio: "pipe" })
		try {
			execSync("git diff --cached --quiet", { cwd: projectDir, stdio: "pipe" })
			emit({ type: "log", level: "done", message: "No changes to commit", ts: ts() })
			return null
		} catch {
			// There are staged changes — proceed
		}
		const safeMsg = message.replace(/"/g, '\\"')
		execSync(`git commit -m "${safeMsg}"`, { cwd: projectDir, stdio: "pipe" })
		const hash = execSync("git rev-parse HEAD", {
			cwd: projectDir,
			encoding: "utf-8",
			stdio: "pipe",
		}).trim()
		emit({ type: "log", level: "done", message: `Committed: ${message}`, ts: ts() })
		return hash
	} catch (err) {
		const msg = err instanceof Error ? err.message : "unknown error"
		emit({ type: "log", level: "error", message: `Git commit failed: ${msg}`, ts: ts() })
		return null
	}
}

/**
 * Push to remote origin if configured. Silently skips if no remote exists.
 */
function gitAutoPush(projectDir: string, emit: (event: EngineEvent) => void | Promise<void>): void {
	try {
		// Check if a remote origin exists
		const remote = execSync("git remote get-url origin", {
			cwd: projectDir,
			encoding: "utf-8",
			stdio: "pipe",
		}).trim()
		if (!remote) {
			emit({
				type: "log",
				level: "verbose",
				message: "No remote configured — skipping push",
				ts: ts(),
			})
			return
		}

		const branch = execSync("git branch --show-current", {
			cwd: projectDir,
			encoding: "utf-8",
			stdio: "pipe",
		}).trim()
		emit({ type: "log", level: "task", message: `Pushing to origin/${branch}...`, ts: ts() })
		const pushOutput = execSync(`git push -u origin ${branch} 2>&1`, {
			cwd: projectDir,
			encoding: "utf-8",
			timeout: 60_000,
			env: { ...process.env },
		}).trim()
		if (pushOutput) {
			emit({ type: "log", level: "verbose", message: pushOutput, ts: ts() })
		}
		emit({ type: "log", level: "done", message: `Pushed to origin/${branch}`, ts: ts() })
	} catch (err) {
		const detail =
			(err as Record<string, string>)?.stderr ||
			(err as Record<string, string>)?.stdout ||
			(err instanceof Error ? err.message : "Push failed")
		emit({
			type: "log",
			level: "error",
			message: `Git push failed: ${detail}`,
			ts: ts(),
		})
	}
}

/**
 * Create a ProgressReporter that works for both CLI and web by forwarding to the engine callback.
 * The reporter is used by scaffold and other components that need it directly.
 */
function createReporterFromCallbacks(
	_callbacks: OrchestratorCallbacks,
	verbose?: boolean,
): ProgressReporter {
	return createProgressReporter({ verbose })
}
