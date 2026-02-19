import { spawn } from "node:child_process"
import { createHeadlessAdapter } from "../engine/headless-adapter.js"
import { runIterate, runNew } from "../engine/orchestrator.js"

/**
 * Handler for `electric-agent headless`.
 *
 * Uses a single stdin reader: first line is JSON config,
 * subsequent lines are gate responses.
 */
export async function headlessCommand(): Promise<void> {
	const { readConfig, callbacks, close } = createHeadlessAdapter()

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

	try {
		if (config.command === "new") {
			if (!config.description) {
				process.stderr.write('Error: "description" is required for command "new"\n')
				process.exitCode = 1
				return
			}

			const result = await runNew({
				description: config.description,
				projectName: config.projectName,
				baseDir: config.baseDir || process.cwd(),
				callbacks,
			})

			// In sandbox mode, run migrations and start the dev server
			if (process.env.SANDBOX_MODE === "1" && result.projectDir) {
				await startSandboxDevServer(result.projectDir, callbacks.onEvent)
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

			await runIterate({
				projectDir: config.projectDir,
				userRequest: config.request,
				callbacks,
				resumeSessionId: config.resumeSessionId,
			})
		} else {
			process.stderr.write(`Error: Unknown command "${config.command}"\n`)
			process.exitCode = 1
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Unknown error"
		process.stderr.write(`Fatal: ${msg}\n`)
		process.exitCode = 1
	} finally {
		close()
	}
}

/**
 * After generation completes in sandbox mode:
 * 1. Run drizzle-kit migrate
 * 2. Start pnpm dev --host --port 5173 as foreground process
 */
async function startSandboxDevServer(
	projectDir: string,
	emit: (event: import("../engine/events.js").EngineEvent) => void | Promise<void>,
): Promise<void> {
	const { ts } = await import("../engine/events.js")
	const { execSync } = await import("node:child_process")

	// Step 1: Run migrations
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
		// Continue anyway — the dev server may still be useful
	}

	// Step 2: Start dev server
	emit({
		type: "log",
		level: "done",
		message: "Starting dev server on port 5173...",
		ts: ts(),
	})

	const devServer = spawn("pnpm", ["dev", "--host", "--port", "5173"], {
		cwd: projectDir,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env },
	})

	devServer.stdout?.on("data", (data: Buffer) => {
		process.stdout.write(data)
	})
	devServer.stderr?.on("data", (data: Buffer) => {
		process.stderr.write(data)
	})

	// Keep alive until the dev server exits or the process is killed
	await new Promise<void>((resolve) => {
		devServer.on("exit", () => resolve())
		process.on("SIGTERM", () => {
			devServer.kill()
			resolve()
		})
		process.on("SIGINT", () => {
			devServer.kill()
			resolve()
		})
	})
}
