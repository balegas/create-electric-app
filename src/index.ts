#!/usr/bin/env node

import { Command } from "commander"
import { downCommand } from "./cli/down.js"
import { iterateCommand } from "./cli/iterate.js"
import { newCommand } from "./cli/new.js"
import { statusCommand } from "./cli/status.js"
import { upCommand } from "./cli/up.js"

const program = new Command()

program
	.name("electric-agent")
	.description(
		"Turn natural-language app descriptions into running reactive Electric SQL + TanStack DB applications",
	)
	.version("0.1.0")

program
	.command("new")
	.description("Create a new Electric app from a natural-language description")
	.argument("<description>", "Natural-language description of the app to build")
	.option("-n, --name <name>", "Project name (derived from description if not provided)")
	.option("--no-approve", "Skip plan approval prompt and start building immediately")
	.action(async (description: string, opts: { name?: string; approve?: boolean }) => {
		await newCommand(description, opts)
	})

program
	.command("iterate")
	.description("Enter conversational iteration mode for an existing project")
	.action(async () => {
		await iterateCommand()
	})

program
	.command("status")
	.description("Show the current project status and progress")
	.action(async () => {
		await statusCommand()
	})

program
	.command("up")
	.description("Start Docker services, run migrations, and launch the dev server")
	.action(async () => {
		await upCommand()
	})

program
	.command("down")
	.description("Stop Docker services and dev server")
	.action(async () => {
		await downCommand()
	})

program.parse()
