import { execSync } from "node:child_process"
import type { EngineEvent } from "../engine/events.js"
import { ts } from "../engine/events.js"
import { type OrchestratorCallbacks, runIterate, runNew } from "../engine/orchestrator.js"
import { createStdioAdapter } from "../engine/stdio-adapter.js"
import { createStreamAdapter } from "../engine/stream-adapter.js"

/**
 * Handler for `electric-agent headless`.
 *
 * Communicates via either:
 * 1. Hosted Durable Stream (if DS_URL + DS_SERVICE_ID + DS_SECRET + SESSION_ID are set)
 * 2. stdin/stdout NDJSON (fallback — used in Daytona sandboxes without internet)
 */
export async function headlessCommand(): Promise<void> {
	const dsUrl = process.env.DS_URL
	const dsServiceId = process.env.DS_SERVICE_ID
	const dsSecret = process.env.DS_SECRET
	const sessionId = process.env.SESSION_ID

	const useStream = !!(dsUrl && dsServiceId && dsSecret && sessionId)

	let adapter: ReturnType<typeof createStreamAdapter> | ReturnType<typeof createStdioAdapter>

	if (useStream) {
		process.stderr.write("[headless] Using stream adapter (Durable Streams)\n")
		const streamUrl = `${dsUrl}/v1/stream/${dsServiceId}/session/${sessionId}`
		const streamAdapter = createStreamAdapter(streamUrl, dsSecret)
		await streamAdapter.startListening()
		adapter = streamAdapter
	} else {
		process.stderr.write("[headless] Using stdio adapter (stdin/stdout NDJSON)\n")
		adapter = createStdioAdapter()
	}

	const { readConfig, waitForCommand, callbacks, close } = adapter

	let config: Awaited<ReturnType<typeof readConfig>>
	try {
		config = await readConfig()
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Failed to read config"
		process.stderr.write(`Error: ${msg}\n`)
		process.exitCode = 1
		close()
		return
	}

	let projectDir: string | undefined

	try {
		if (config.command === "new") {
			if (!config.description) {
				process.stderr.write('Error: "description" is required for command "new"\n')
				process.exitCode = 1
				return
			}

			const baseDir = config.baseDir || process.cwd()

			// Validate gh auth if GH_TOKEN is available
			if (process.env.GH_TOKEN) {
				const ghCmd = "gh auth status"
				const ghToolUseId = `early-gh-${Date.now()}`
				callbacks.onEvent({
					type: "tool_start",
					toolName: "bash",
					toolUseId: ghToolUseId,
					input: { command: ghCmd },
					ts: ts(),
				})
				try {
					const ghOut = execSync(`${ghCmd} 2>&1`, {
						encoding: "utf-8",
						timeout: 10_000,
						env: { ...process.env },
					}).trim()
					callbacks.onEvent({
						type: "tool_result",
						toolUseId: ghToolUseId,
						output: ghOut || "(ok)",
						ts: ts(),
					})
				} catch (e) {
					const stderr =
						(e as Record<string, string>)?.stderr ||
						(e as Record<string, string>)?.stdout ||
						"auth check failed"
					callbacks.onEvent({
						type: "tool_result",
						toolUseId: ghToolUseId,
						output: `Error: ${stderr}`,
						ts: ts(),
					})
					callbacks.onEvent({
						type: "log",
						level: "error",
						message: "GitHub CLI auth check failed — repo creation may not work",
						ts: ts(),
					})
				}
			}

			const result = await runNew({
				description: config.description,
				projectName: config.projectName,
				baseDir,
				callbacks,
				gitRepoName: config.gitRepoName,
				gitRepoVisibility: config.gitRepoVisibility,
			})

			projectDir = result.projectDir

			// In sandbox mode, run migrations and start the dev server
			if (process.env.SANDBOX_MODE === "1" && projectDir) {
				await startSandboxDevServer(projectDir, callbacks.onEvent)
			}
		} else if (config.command === "iterate") {
			if (!config.projectDir) {
				process.stderr.write('Error: "projectDir" is required for command "iterate"\n')
				process.exitCode = 1
				return
			}
			if (!config.request) {
				process.stderr.write('Error: "request" is required for command "iterate"\n')
				process.exitCode = 1
				return
			}

			projectDir = config.projectDir

			await runIterate({
				projectDir: config.projectDir,
				userRequest: config.request,
				callbacks,
				resumeSessionId: config.resumeSessionId,
			})
		} else if (config.command === "git") {
			if (!config.projectDir) {
				process.stderr.write('Error: "projectDir" is required for command "git"\n')
				process.exitCode = 1
				return
			}
			if (!config.gitOp) {
				process.stderr.write('Error: "gitOp" is required for command "git"\n')
				process.exitCode = 1
				return
			}

			projectDir = config.projectDir

			const gitSuccess = executeGitOp(config, callbacks.onEvent)
			callbacks.onEvent({
				type: "session_complete",
				success: gitSuccess,
				ts: ts(),
			})
		} else {
			process.stderr.write(`Error: Unknown command "${config.command}"\n`)
			process.exitCode = 1
			return
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Unknown error"
		process.stderr.write(`Fatal: ${msg}\n`)
		process.exitCode = 1
		close()
		return
	}

	// Emit session_complete for the initial command
	callbacks.onEvent({ type: "session_complete", success: true, ts: ts() })

	// Keep listening for iterate commands (Vite HMR picks up changes live)
	if (process.env.SANDBOX_MODE === "1") {
		await listenForIterations(projectDir, waitForCommand, callbacks)
	}

	close()
}

/** HeadlessConfig type for git operations */
interface HeadlessConfig {
	command: string
	projectDir?: string
	request?: string
	resumeSessionId?: string
	gitOp?: "commit" | "push" | "create-repo" | "create-pr"
	gitMessage?: string
	gitRepoName?: string
	gitRepoVisibility?: "public" | "private"
	gitPrTitle?: string
	gitPrBody?: string
}

/**
 * Listen for iterate commands and run them.
 * The dev server stays running — Vite HMR handles live reloads.
 */
async function listenForIterations(
	projectDir: string | undefined,
	waitForCommand: () => Promise<{
		command: string
		projectDir?: string
		request?: string
		resumeSessionId?: string
	}>,
	callbacks: OrchestratorCallbacks,
): Promise<void> {
	while (true) {
		let cmd: Awaited<ReturnType<typeof waitForCommand>>
		try {
			cmd = await waitForCommand()
		} catch {
			// Stream closed — exit gracefully
			break
		}

		if (cmd.command === "git") {
			const gitCmd = cmd as unknown as HeadlessConfig
			if (!gitCmd.gitOp || !gitCmd.projectDir) {
				callbacks.onEvent({
					type: "log",
					level: "error",
					message: "git command requires projectDir and gitOp",
					ts: ts(),
				})
				callbacks.onEvent({ type: "session_complete", success: false, ts: ts() })
				continue
			}

			const gitSuccess = executeGitOp(
				{ ...gitCmd, projectDir: gitCmd.projectDir || projectDir },
				callbacks.onEvent,
			)
			callbacks.onEvent({ type: "session_complete", success: gitSuccess, ts: ts() })
			continue
		}

		if (cmd.command !== "iterate") {
			callbacks.onEvent({
				type: "log",
				level: "error",
				message: `Unexpected command "${cmd.command}" — only "iterate" and "git" are supported after initial run`,
				ts: ts(),
			})
			continue
		}

		const iterateDir = cmd.projectDir || projectDir
		if (!iterateDir || !cmd.request) {
			callbacks.onEvent({
				type: "log",
				level: "error",
				message: "iterate requires projectDir and request",
				ts: ts(),
			})
			continue
		}

		try {
			await runIterate({
				projectDir: iterateDir,
				userRequest: cmd.request,
				callbacks,
				resumeSessionId: cmd.resumeSessionId,
			})

			// Run migrations after code changes (schema may have changed)
			if (iterateDir) {
				runMigrations(iterateDir, callbacks.onEvent)
			}

			callbacks.onEvent({ type: "session_complete", success: true, ts: ts() })
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Unknown error"
			callbacks.onEvent({
				type: "log",
				level: "error",
				message: `Iteration failed: ${msg}`,
				ts: ts(),
			})
			callbacks.onEvent({ type: "session_complete", success: false, ts: ts() })
		}
	}
}

/**
 * Execute a structured git operation directly via execSync.
 * Returns true on success, false on failure.
 */
function executeGitOp(
	config: HeadlessConfig,
	emit: (event: EngineEvent) => void | Promise<void>,
): boolean {
	const cwd = config.projectDir ?? ""
	const op = config.gitOp ?? "commit"
	const toolUseId = `git-${op}-${Date.now()}`

	function run(cmd: string): string {
		emit({ type: "tool_start", toolName: "bash", toolUseId, input: { command: cmd }, ts: ts() })
		try {
			const output = execSync(cmd, {
				cwd,
				encoding: "utf-8",
				timeout: 60_000,
				env: { ...process.env },
				stdio: ["pipe", "pipe", "pipe"],
			}).trim()
			emit({ type: "tool_result", toolUseId, output: output || "(ok)", ts: ts() })
			return output
		} catch (e) {
			const stderr = (e as Record<string, string>)?.stderr || ""
			const stdout = (e as Record<string, string>)?.stdout || ""
			const detail = stderr || stdout || (e instanceof Error ? e.message : "Command failed")
			emit({ type: "tool_result", toolUseId, output: `Error: ${detail}`, ts: ts() })
			throw new Error(detail)
		}
	}

	try {
		switch (op) {
			case "commit": {
				const message = config.gitMessage || "commit"
				run("git add -A")
				try {
					execSync("git diff --cached --quiet", { cwd, stdio: "pipe" })
					emit({
						type: "log",
						level: "done",
						message: "No changes to commit",
						ts: ts(),
					})
					return true
				} catch {
					// There are staged changes — proceed
				}
				const safeMsg = message.replace(/"/g, '\\"')
				run(`git commit -m "${safeMsg}"`)
				const hash = run("git rev-parse HEAD")
				emit({
					type: "git_checkpoint",
					commitHash: hash,
					message,
					ts: ts(),
				})
				return true
			}
			case "push": {
				const branch = run("git rev-parse --abbrev-ref HEAD")
				run(`git push -u origin ${branch}`)
				emit({
					type: "log",
					level: "done",
					message: `Pushed to origin/${branch}`,
					ts: ts(),
				})
				return true
			}
			case "create-repo": {
				const name = config.gitRepoName
				if (!name) {
					emit({
						type: "log",
						level: "error",
						message: "gitRepoName is required for create-repo",
						ts: ts(),
					})
					return false
				}
				const vis = config.gitRepoVisibility || "private"
				run(`gh repo create "${name}" --${vis} --source . --remote origin --push`)
				emit({
					type: "log",
					level: "done",
					message: `GitHub repo created: ${name} (${vis})`,
					ts: ts(),
				})
				return true
			}
			case "create-pr": {
				const title = config.gitPrTitle || "Changes from electric-agent"
				const body =
					config.gitPrBody ||
					"Generated by electric-agent.\n\nReview the changes and merge when ready."
				const safeTitle = title.replace(/"/g, '\\"')
				const safeBody = body.replace(/"/g, '\\"')
				const output = run(`gh pr create --title "${safeTitle}" --body "${safeBody}"`)
				emit({
					type: "log",
					level: "done",
					message: `PR created: ${output}`,
					ts: ts(),
				})
				return true
			}
			default:
				emit({
					type: "log",
					level: "error",
					message: `Unknown git operation: ${op}`,
					ts: ts(),
				})
				return false
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Git operation failed"
		emit({ type: "log", level: "error", message: `Git ${op} failed: ${msg}`, ts: ts() })
		return false
	}
}

/**
 * Run drizzle-kit migrations.
 */
function runMigrations(
	projectDir: string,
	emit: (event: EngineEvent) => void | Promise<void>,
): void {
	emit({ type: "log", level: "build", message: "Running migrations...", ts: ts() })
	try {
		execSync("pnpm migrate", {
			cwd: projectDir,
			stdio: "pipe",
			timeout: 60_000,
			env: { ...process.env },
		})
		emit({ type: "log", level: "done", message: "Migrations complete", ts: ts() })
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Migration failed"
		emit({ type: "log", level: "error", message: `Migration failed: ${msg}`, ts: ts() })
	}
}

/**
 * After generation completes in sandbox mode:
 * 1. Run pnpm migrate (drizzle-kit)
 * 2. Start pnpm dev via the dev:start script
 * 3. Emit app_ready event
 */
async function startSandboxDevServer(
	projectDir: string,
	emit: (event: EngineEvent) => void | Promise<void>,
): Promise<void> {
	// Step 1: Run migrations
	runMigrations(projectDir, emit)

	// Step 2: Start dev server using the scaffold script (creates PID file)
	emit({
		type: "log",
		level: "done",
		message: "Starting dev server on port 5173...",
		ts: ts(),
	})

	execSync("pnpm dev:start", {
		cwd: projectDir,
		stdio: "pipe",
		timeout: 10_000,
		env: { ...process.env },
	})

	// Step 3: Emit app_ready — the dev server is running in the background
	emit({ type: "app_ready", port: 5173, ts: ts() })
}
