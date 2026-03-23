import type { LogLevel } from "@electric-agent/protocol"

/** ANSI color codes for log levels */
const LOG_COLORS: Record<LogLevel, string> = {
	plan: "\x1b[36m", // cyan
	approve: "\x1b[32m", // green
	task: "\x1b[33m", // yellow
	build: "\x1b[34m", // blue
	fix: "\x1b[35m", // magenta
	done: "\x1b[32m", // green
	system: "\x1b[90m", // gray
	error: "\x1b[31m", // red
	verbose: "\x1b[90m", // gray
}

const RESET = "\x1b[0m"

export function colorForLevel(level: LogLevel): string {
	return LOG_COLORS[level] ?? ""
}

export function formatLogLevel(level: LogLevel): string {
	return `${LOG_COLORS[level]}[${level}]${RESET}`
}

export function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text
	return text.slice(0, maxLen - 1) + "\u2026"
}

export function formatTimestamp(ts: string): string {
	try {
		const d = new Date(ts)
		return d.toLocaleTimeString("en-US", { hour12: false })
	} catch {
		return ""
	}
}

export function maskCredential(value: string | undefined): string {
	if (!value) return "(not set)"
	if (value.length <= 8) return "\u2022".repeat(value.length)
	return "\u2022".repeat(value.length - 4) + value.slice(-4)
}

export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
	// Show the most relevant field for common tools
	if (input.file_path) return String(input.file_path)
	if (input.command) return truncate(String(input.command), 60)
	if (input.pattern) return String(input.pattern)
	if (input.query) return truncate(String(input.query), 60)
	return ""
}
