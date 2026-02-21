import { type ChildProcess, execSync, spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { runGitAgent } from "../agents/git-agent.js"
import type { EngineEvent } from "../engine/events.js"
import { ts } from "../engine/events.js"
import { createHeadlessAdapter } from "../engine/headless-adapter.js"
import { type OrchestratorCallbacks, runIterate, runNew } from "../engine/orchestrator.js"

/**
 * Handler for `electric-agent headless`.
 *
 * Uses a single stdin reader: first line is JSON config,
 * subsequent lines are either gate responses or new commands.
 *
 * After the initial "new" command completes, the dev server starts
 * in the background and the process keeps listening for "iterate"
 * commands. Vite HMR picks up code changes automatically.
 */
export async function headlessCommand(): Promise<void> {
	const { readConfig, waitForCommand, callbacks, close } = createHeadlessAdapter()

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
	let devServer: ChildProcess | undefined

	try {
		if (config.command === "new") {
			if (!config.description) {
				process.stderr.write('Error: "description" is required for command "new"\n')
				process.exitCode = 1
				return
			}

			// Early git init so users can debug intermediate states
			const baseDir = config.baseDir || process.cwd()
			const projectName = config.projectName || "project"
			const earlyDir = path.join(baseDir, projectName)
			mkdirSync(earlyDir, { recursive: true })
			try {
				const gitCmds = [
					"git init -b main",
					'git config user.email "electric-agent@local"',
					'git config user.name "Electric Agent"',
				]
				for (const cmd of gitCmds) {
					const toolUseId = `early-git-${Date.now()}`
					callbacks.onEvent({ type: "tool_start", toolName: "bash", toolUseId, input: { command: cmd }, ts: ts() })
					const output = execSync(cmd, { cwd: earlyDir, stdio: "pipe" }).toString().trim()
					callbacks.onEvent({ type: "tool_result", toolUseId, output: output || "(ok)", ts: ts() })
				}
				callbacks.onEvent({ type: "log", level: "done", message: "Git repository initialized", ts: ts() })
			} catch {
				/* non-fatal — git init may fail if dir already has a repo */
			}

			const result = await runNew({
				description: config.description,
				projectName: config.projectName,
				baseDir,
				callbacks,
				initGit: false,
			})

			projectDir = result.projectDir

			// In sandbox mode, run migrations and start the dev server in the background
			if (process.env.SANDBOX_MODE === "1" && projectDir) {
				devServer = await startSandboxDevServer(projectDir, callbacks.onEvent)
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
			if (!config.gitTask) {
				process.stderr.write('Error: "gitTask" is required for command "git"\n')
				process.exitCode = 1
				return
			}

			projectDir = config.projectDir

			const gitResult = await runGitAgent({
				projectDir: config.projectDir,
				task: config.gitTask,
				onMessage: (msg) => {
					callbacks.onEvent(msg as unknown as EngineEvent)
				},
			})
			callbacks.onEvent({
				type: "session_complete",
				success: gitResult.success,
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
		await listenForIterations(projectDir, devServer, waitForCommand, callbacks)
	}

	close()
}

/**
 * Listen for iterate commands on stdin and run them.
 * The dev server stays running — Vite HMR handles live reloads.
 */
async function listenForIterations(
	projectDir: string | undefined,
	devServer: ChildProcess | undefined,
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
			// Stdin closed — exit gracefully
			break
		}

		if (cmd.command === "git") {
			const gitDir = cmd.projectDir || projectDir
			const gitTask = (cmd as Record<string, unknown>).gitTask as string | undefined
			if (!gitDir || !gitTask) {
				callbacks.onEvent({
					type: "log",
					level: "error",
					message: "git command requires projectDir and gitTask",
					ts: ts(),
				})
				continue
			}

			try {
				const gitResult = await runGitAgent({
					projectDir: gitDir,
					task: gitTask,
					onMessage: (msg) => {
						callbacks.onEvent(msg as unknown as EngineEvent)
					},
				})
				callbacks.onEvent({ type: "session_complete", success: gitResult.success, ts: ts() })
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Git operation failed"
				callbacks.onEvent({
					type: "log",
					level: "error",
					message: `Git failed: ${msg}`,
					ts: ts(),
				})
				callbacks.onEvent({ type: "session_complete", success: false, ts: ts() })
			}
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

	// Clean up dev server when stdin closes
	if (devServer && !devServer.killed) {
		devServer.kill()
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
		execSync("npx drizzle-kit migrate", {
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
 * 1. Run drizzle-kit migrate
 * 2. Start pnpm dev via the dev:start script (creates PID file for dev:stop)
 *
 * Returns the wrapper child process (dev server runs in background via nohup).
 */
async function startSandboxDevServer(
	projectDir: string,
	emit: (event: EngineEvent) => void | Promise<void>,
): Promise<ChildProcess> {
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

	// Tail the dev server log so output reaches the container bridge via stderr
	const logTail = spawn("tail", ["-f", "/tmp/dev-server.log"], {
		cwd: projectDir,
		stdio: ["ignore", "pipe", "pipe"],
	})

	logTail.stdout?.on("data", (data: Buffer) => {
		process.stderr.write(data)
	})

	return logTail
}
