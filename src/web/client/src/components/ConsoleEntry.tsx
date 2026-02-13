import type { ConsoleEntry as ConsoleEntryType } from "../lib/event-types"

const LEVEL_LABELS: Record<string, string> = {
	plan: "[plan]",
	approve: "[approve]",
	task: "[task]",
	build: "[build]",
	fix: "[fix]",
	done: "[done]",
	error: "[error]",
	debug: "[debug]",
}

export function ConsoleLogEntry({ entry }: { entry: Extract<ConsoleEntryType, { kind: "log" }> }) {
	return (
		<div className="console-entry">
			<span className={`prefix ${entry.level}`}>{LEVEL_LABELS[entry.level]}</span>
			<span>{entry.message}</span>
		</div>
	)
}

export function ConsoleTextEntry({
	entry,
}: {
	entry: Extract<ConsoleEntryType, { kind: "text" }>
}) {
	return (
		<div className="assistant-text">
			{entry.text.slice(0, 300)}
			{entry.text.length > 300 ? "..." : ""}
		</div>
	)
}
