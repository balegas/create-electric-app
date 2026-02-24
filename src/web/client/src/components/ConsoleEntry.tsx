import type { ConsoleEntry as ConsoleEntryType } from "../lib/event-types"
import { Markdown } from "./Markdown"

const LEVEL_LABELS: Record<string, string> = {
	plan: "[plan]",
	approve: "[approve]",
	task: "[task]",
	build: "[build]",
	fix: "[fix]",
	done: "[done]",
	error: "[error]",
	verbose: "[verbose]",
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
	entry: Extract<ConsoleEntryType, { kind: "user_prompt" }>
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

export function ConsoleThinkingEntry({
	entry,
	duration,
}: {
	entry: Extract<ConsoleEntryType, { kind: "assistant_thinking" }>
	duration: string | null
}) {
	const label = entry.agent || "agent"
	return (
		<details className="thinking-inline">
			<summary>
				<span className="thinking-label">[{label}] Thinking</span>
				<span className="thinking-preview">{entry.text.slice(0, 100)}...</span>
				<Duration value={duration} />
			</summary>
			<div className="thinking-body">
				<Markdown inline>{entry.text}</Markdown>
			</div>
		</details>
	)
}

const COLLAPSE_THRESHOLD = 300

export function ConsoleTextEntry({
	entry,
	duration,
}: {
	entry: Extract<ConsoleEntryType, { kind: "assistant_message" }>
	duration: string | null
}) {
	const label = entry.agent || "agent"
	if (entry.text.length <= COLLAPSE_THRESHOLD) {
		return (
			<div className="console-entry">
				<span className="prefix task">[{label}]</span>
				<span>
					<Markdown inline>{entry.text}</Markdown>
				</span>
				<Duration value={duration} />
			</div>
		)
	}

	return (
		<details className="tool-inline">
			<summary>
				<span className="tool-inline-name">{label}</span>
				<span className="tool-inline-summary">{entry.text.slice(0, 120)}...</span>
				<Duration value={duration} />
			</summary>
			<div className="tool-inline-body">
				<Markdown>{entry.text}</Markdown>
			</div>
		</details>
	)
}
