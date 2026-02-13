import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createProgressReporter } from "../progress/reporter.js"

export async function downCommand(opts?: { debug?: boolean }): Promise<void> {
	const projectDir = process.cwd()
	const reporter = createProgressReporter({ debug: opts?.debug })

	if (!fs.existsSync(path.join(projectDir, "docker-compose.yml"))) {
		reporter.log("error", "No docker-compose.yml found in current directory")
		process.exit(1)
	}

	reporter.log("task", "Stopping Docker services...")
	execSync("docker compose down", { cwd: projectDir, stdio: "inherit" })
	reporter.log("done", "Services stopped")
}
