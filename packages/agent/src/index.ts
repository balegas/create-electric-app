#!/usr/bin/env node

import { createRequire } from "node:module"
import { Command } from "commander"
import dotenv from "dotenv"
import { headlessCommand } from "./cli/headless.js"
import { serveCommand } from "./cli/serve.js"
import { findUp } from "./find-env.js"

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
