#!/usr/bin/env node

import "dotenv/config"
import { Command } from "commander"
import { headlessCommand } from "./cli/headless.js"
import { serveCommand } from "./cli/serve.js"

const program = new Command()

program
	.name("electric-agent")
	.description(
		"Turn natural-language app descriptions into running reactive Electric SQL + TanStack DB applications",
	)
	.version("0.1.0")
	.option("--verbose", "Enable verbose logging")

program
	.command("headless")
	.description("Run in headless mode communicating via hosted Durable Streams")
	.action(async () => {
		await headlessCommand()
	})

program
	.command("serve")
	.description("Start the web UI server")
	.option("-p, --port <number>", "Web server port", "4400")
	.option("--data-dir <path>", "Data directory for persistence", ".electric-agent")
	.option("--open", "Open browser on start")
	.action(async (opts: { port?: string; dataDir?: string; open?: boolean }) => {
		await serveCommand({
			port: opts.port ? parseInt(opts.port, 10) : undefined,
			dataDir: opts.dataDir,
			open: opts.open,
		})
	})

program.parse()
