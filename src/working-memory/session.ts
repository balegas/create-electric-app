import fs from "node:fs"
import path from "node:path"

export interface SessionState {
	appName: string
	currentPhase: string
	currentTask: string
	buildStatus: string
	totalBuilds: number
	totalErrors: number
	escalations: number
}

const SESSION_FILE = "_agent/session.md"

const DEFAULTS: SessionState = {
	appName: "unknown",
	currentPhase: "init",
	currentTask: "none",
	buildStatus: "pending",
	totalBuilds: 0,
	totalErrors: 0,
	escalations: 0,
}

function sessionPath(projectDir: string): string {
	return path.join(projectDir, SESSION_FILE)
}

export async function readSession(projectDir: string): Promise<SessionState> {
	const filePath = sessionPath(projectDir)
	if (!fs.existsSync(filePath)) return { ...DEFAULTS }

	const content = fs.readFileSync(filePath, "utf-8")
	const state = { ...DEFAULTS } as SessionState

	for (const line of content.split("\n")) {
		const match = line.match(/^- \*\*(.+?):\*\*\s*(.+)$/)
		if (match) {
			const key = match[1]
			const value = match[2].trim()

			switch (key) {
				case "App Name":
					state.appName = value
					break
				case "Current Phase":
					state.currentPhase = value
					break
				case "Current Task":
					state.currentTask = value
					break
				case "Build Status":
					state.buildStatus = value
					break
				case "Total Builds":
					state.totalBuilds = parseInt(value, 10) || 0
					break
				case "Total Errors":
					state.totalErrors = parseInt(value, 10) || 0
					break
				case "Escalations":
					state.escalations = parseInt(value, 10) || 0
					break
			}
		}
	}

	return state as SessionState
}

export async function updateSession(
	projectDir: string,
	data: Partial<SessionState>,
): Promise<void> {
	const current = await readSession(projectDir)
	const updated = { ...current, ...data }

	const content = `# Session State

- **App Name:** ${updated.appName}
- **Current Phase:** ${updated.currentPhase}
- **Current Task:** ${updated.currentTask}
- **Build Status:** ${updated.buildStatus}
- **Total Builds:** ${updated.totalBuilds}
- **Total Errors:** ${updated.totalErrors}
- **Escalations:** ${updated.escalations}
`

	const filePath = sessionPath(projectDir)
	fs.mkdirSync(path.dirname(filePath), { recursive: true })
	fs.writeFileSync(filePath, content, "utf-8")
}
