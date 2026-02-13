import fs from "node:fs"
import path from "node:path"
import { createProgressReporter } from "../progress/reporter.js"
import { readSession } from "../working-memory/session.js"

export async function statusCommand(opts?: { debug?: boolean }): Promise<void> {
	const projectDir = process.cwd()
	const reporter = createProgressReporter({ debug: opts?.debug })

	if (!fs.existsSync(path.join(projectDir, "PLAN.md"))) {
		reporter.log("error", "Not in an Electric Agent project directory (no PLAN.md found)")
		process.exit(1)
	}

	// Parse PLAN.md for task progress
	const planContent = fs.readFileSync(path.join(projectDir, "PLAN.md"), "utf-8")
	const checkedTasks = (planContent.match(/- \[x\]/g) || []).length
	const uncheckedTasks = (planContent.match(/- \[ \]/g) || []).length
	const totalTasks = checkedTasks + uncheckedTasks

	// Read session state
	const session = await readSession(projectDir)

	console.log("\n=== Electric Agent Status ===\n")
	console.log(`  App:          ${session.appName || "unknown"}`)
	console.log(`  Phase:        ${session.currentPhase || "unknown"}`)
	console.log(`  Current Task: ${session.currentTask || "none"}`)
	console.log(
		`  Progress:     ${checkedTasks}/${totalTasks} tasks (${totalTasks > 0 ? Math.round((checkedTasks / totalTasks) * 100) : 0}%)`,
	)
	console.log(`  Build Status: ${session.buildStatus || "unknown"}`)
	console.log(`  Total Builds: ${session.totalBuilds || 0}`)
	console.log(`  Total Errors: ${session.totalErrors || 0}`)
	console.log(`  Escalations:  ${session.escalations || 0}`)
	console.log()
}
