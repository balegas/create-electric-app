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

export function Duration({ value }: { value: string | null }) {
	if (!value) return null
	return <span className="duration">{value}</span>
}

export function ConsoleLogEntry({
	entry,
	duration,
}: {
	entry: Extract<ConsoleEntryType, { kind: "log" }>
	duration: string | null
}) {
	return (
		<div className="console-entry">
			<span className={`prefix ${entry.level}`}>{LEVEL_LABELS[entry.level]}</span>
			<span>{entry.message}</span>
			<Duration value={duration} />
		</div>
	)
}

export function ConsoleUserMessage({
	entry,
}: {
	entry: Extract<ConsoleEntryType, { kind: "user_message" }>
}) {
	return (
		<div className="console-entry user-message">
			<span className="prefix" style={{ color: "var(--orange)" }}>
				[you]
			</span>
			<span>{entry.message}</span>
		</div>
	)
}

const COLLAPSE_THRESHOLD = 300

export function ConsoleTextEntry({
	entry,
	duration,
}: {
	entry: Extract<ConsoleEntryType, { kind: "text" }>
	duration: string | null
}) {
	if (entry.text.length <= COLLAPSE_THRESHOLD) {
		return (
			<div className="assistant-text">
				<span>{entry.text}</span>
				<Duration value={duration} />
			</div>
		)
	}

	return (
		<details className="assistant-text-collapsible">
			<summary>
				<span className="arrow">&#9654;</span>
				<span className="assistant-text-preview">
					{entry.text.slice(0, 120)}...
				</span>
				<Duration value={duration} />
			</summary>
			<div className="assistant-text-body">
				<pre>{entry.text}</pre>
			</div>
		</details>
	)
}
