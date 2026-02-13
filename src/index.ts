#!/usr/bin/env node

import { Command } from "commander"
import { downCommand } from "./cli/down.js"
import { iterateCommand } from "./cli/iterate.js"
import { newCommand } from "./cli/new.js"
import { serveCommand } from "./cli/serve.js"
import { statusCommand } from "./cli/status.js"
import { upCommand } from "./cli/up.js"

const program = new Command()

program
	.name("electric-agent")
	.description(
		"Turn natural-language app descriptions into running reactive Electric SQL + TanStack DB applications",
	)
	.version("0.1.0")
	.option("--debug", "Enable debug logging")

program
	.command("new")
	.description("Create a new Electric app from a natural-language description")
	.option("-n, --name <name>", "Project name (derived from description if not provided)")
	.option("--no-approve", "Skip plan approval prompt and start building immediately")
	.action(async (opts: { name?: string; approve?: boolean }) => {
		const debug = program.opts().debug ?? false
		await newCommand({ ...opts, debug })
	})

program
	.command("iterate")
	.description("Enter conversational iteration mode for an existing project")
	.action(async () => {
		const debug = program.opts().debug ?? false
		await iterateCommand({ debug })
	})

program
	.command("status")
	.description("Show the current project status and progress")
	.action(async () => {
		const debug = program.opts().debug ?? false
		await statusCommand({ debug })
	})

program
	.command("up")
	.description("Start Docker services, run migrations, and launch the dev server")
	.action(async () => {
		const debug = program.opts().debug ?? false
		await upCommand({ debug })
	})

program
	.command("down")
	.description("Stop Docker services and dev server")
	.action(async () => {
		const debug = program.opts().debug ?? false
		await downCommand({ debug })
	})

program
	.command("serve")
	.description("Start the web UI server")
	.option("-p, --port <number>", "Web server port", "4400")
	.option("--streams-port <number>", "Durable streams server port", "4437")
	.option("--data-dir <path>", "Data directory for persistence", ".electric-agent")
	.option("--open", "Open browser on start")
	.action(
		async (opts: { port?: string; streamsPort?: string; dataDir?: string; open?: boolean }) => {
			await serveCommand({
				port: opts.port ? parseInt(opts.port, 10) : undefined,
				streamsPort: opts.streamsPort ? parseInt(opts.streamsPort, 10) : undefined,
				dataDir: opts.dataDir,
				open: opts.open,
			})
		},
	)

program.parse()
