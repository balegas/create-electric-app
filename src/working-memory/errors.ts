import fs from "node:fs"
import path from "node:path"

export interface ErrorEntry {
	timestamp: string
	errorClass: string
	file: string
	message: string
	attemptedFix: string
	outcome?: string
}

const ERRORS_FILE = "_agent/errors.md"

function errorsPath(projectDir: string): string {
	return path.join(projectDir, ERRORS_FILE)
}

export function readErrors(projectDir: string): ErrorEntry[] {
	const filePath = errorsPath(projectDir)
	if (!fs.existsSync(filePath)) return []

	const content = fs.readFileSync(filePath, "utf-8")
	const entries: ErrorEntry[] = []
	const blocks = content.split("\n## Error ")

	for (const block of blocks.slice(1)) {
		const lines = block.trim().split("\n")
		const entry: Partial<ErrorEntry> = {}

		for (const line of lines) {
			if (line.startsWith("- **Timestamp:**"))
				entry.timestamp = line.replace("- **Timestamp:**", "").trim()
			if (line.startsWith("- **Class:**"))
				entry.errorClass = line.replace("- **Class:**", "").trim()
			if (line.startsWith("- **File:**")) entry.file = line.replace("- **File:**", "").trim()
			if (line.startsWith("- **Message:**"))
				entry.message = line.replace("- **Message:**", "").trim()
			if (line.startsWith("- **Fix:**")) entry.attemptedFix = line.replace("- **Fix:**", "").trim()
			if (line.startsWith("- **Outcome:**"))
				entry.outcome = line.replace("- **Outcome:**", "").trim()
		}

		if (entry.errorClass && entry.message) {
			entries.push(entry as ErrorEntry)
		}
	}

	return entries
}

export function logError(projectDir: string, entry: Omit<ErrorEntry, "timestamp">): void {
	const filePath = errorsPath(projectDir)
	const errors = readErrors(projectDir)
	const index = errors.length + 1
	const timestamp = new Date().toISOString()

	const block = `
## Error ${index}
- **Timestamp:** ${timestamp}
- **Class:** ${entry.errorClass}
- **File:** ${entry.file}
- **Message:** ${entry.message}
- **Fix:** ${entry.attemptedFix}
`

	fs.appendFileSync(filePath, block, "utf-8")
}

export function logOutcome(projectDir: string, entryIndex: number, outcome: string): void {
	const filePath = errorsPath(projectDir)
	if (!fs.existsSync(filePath)) return

	let content = fs.readFileSync(filePath, "utf-8")
	const marker = `## Error ${entryIndex}`
	const idx = content.indexOf(marker)
	if (idx === -1) return

	// Find the next error block or end of file
	const nextIdx = content.indexOf("\n## Error ", idx + marker.length)
	const insertPos = nextIdx === -1 ? content.length : nextIdx

	content =
		content.slice(0, insertPos).trimEnd() +
		`\n- **Outcome:** ${outcome}\n` +
		content.slice(insertPos)

	fs.writeFileSync(filePath, content, "utf-8")
}

export function hasFailedAttempt(
	projectDir: string,
	errorClass: string,
	file: string,
	message: string,
): boolean {
	const errors = readErrors(projectDir)
	return errors.some(
		(e) =>
			e.errorClass === errorClass &&
			e.file === file &&
			e.message === message &&
			e.outcome !== "resolved",
	)
}

export function consecutiveIdenticalFailures(projectDir: string): boolean {
	const errors = readErrors(projectDir)
	if (errors.length < 2) return false

	const last = errors[errors.length - 1]
	const prev = errors[errors.length - 2]

	return (
		last.errorClass === prev.errorClass &&
		last.file === prev.file &&
		last.message === prev.message &&
		last.outcome !== "resolved" &&
		prev.outcome !== "resolved"
	)
}
