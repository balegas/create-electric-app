#!/usr/bin/env node

import { createRequire } from "node:module"
import { Command } from "commander"
import dotenv from "dotenv"
import { findUp } from "./find-env.js"
import { scaffold } from "./scaffold/index.js"

dotenv.config({ path: findUp(".env") })

const require = createRequire(import.meta.url)
const { version } = require("../package.json") as { version: string }

const program = new Command()

program
	.name("electric-agent")
	.description(
		"Turn natural-language app descriptions into running reactive Electric SQL + TanStack DB applications",
	)
	.version(version)
	.option("--verbose", "Enable verbose logging")

program
	.command("serve")
	.description("Start the web UI server")
	.option("-p, --port <number>", "Web server port", "4400")
	.option("--data-dir <path>", "Data directory for persistence", ".electric-agent")
	.option("--open", "Open browser on start")
	.action(async (opts: { port?: string; dataDir?: string; open?: boolean }) => {
		const { serveCommand } = await import("./cli/serve.js")
		await serveCommand({
			port: opts.port ? parseInt(opts.port, 10) : undefined,
			dataDir: opts.dataDir,
			open: opts.open,
		})
	})

program
	.command("scaffold")
	.description("Scaffold a new Electric + TanStack DB project")
	.argument("<dir>", "Target project directory")
	.option("-n, --name <name>", "Project name")
	.option("--skip-install", "Skip dependency installation")
	.option("--skip-git", "Skip git initialization")
	.action(
		async (dir: string, opts: { name?: string; skipInstall?: boolean; skipGit?: boolean }) => {
			const result = await scaffold(dir, {
				projectName: opts.name,
				skipInstall: opts.skipInstall,
				skipGit: opts.skipGit,
			})
			if (result.errors.length > 0) {
				console.error("Scaffold completed with errors:")
				for (const e of result.errors) console.error(`  - ${e}`)
				process.exit(1)
			}
			console.log(`Scaffolded project at ${result.projectDir}`)
		},
	)

program
	.command("create")
	.description("Create an app in headless mode (room + agents, auto-provision)")
	.argument("<description>", "App description")
	.option("-p, --port <number>", "Server port (starts server if not running)", "4400")
	.option("--server <url>", "Connect to existing server instead of starting one")
	.action(async (description: string, opts: { port?: string; server?: string }) => {
		const { createCommand } = await import("./cli/create.js")
		await createCommand(description, {
			port: opts.port ? parseInt(opts.port, 10) : undefined,
			serverUrl: opts.server,
		})
	})

program.parse()
