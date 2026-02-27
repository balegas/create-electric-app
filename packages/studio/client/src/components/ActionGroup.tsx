import { useState } from "react"
import type { ConsoleEntry } from "../lib/event-types"
import { Duration } from "./ConsoleEntry"
import { ToolExecution } from "./ToolExecution"

type ToolEntry = Extract<ConsoleEntry, { kind: "tool_use" }>

interface ActionGroupProps {
	category: string
	entries: ToolEntry[]
	durations: (string | null)[]
}

/** Labels per category — [active gerund, completed past tense, noun]. */
const CATEGORY_LABELS: Record<string, [string, string, string]> = {
	read: ["Reading", "Read", "files"],
	write: ["Editing", "Edited", "files"],
	run: ["Running", "Ran", "commands"],
}

function aggregateDuration(durations: (string | null)[]): string | null {
	let totalMs = 0
	let any = false
	for (const d of durations) {
		if (!d) continue
		any = true
		// Parse back from formatted string
		if (d.endsWith("ms")) {
			totalMs += Number.parseInt(d, 10)
		} else if (d.includes("m ")) {
			const [m, s] = d.split("m ")
			totalMs += Number.parseInt(m, 10) * 60_000 + Number.parseFloat(s) * 1000
		} else if (d.endsWith("s")) {
			totalMs += Number.parseFloat(d) * 1000
		}
	}
	if (!any) return null
	if (totalMs < 1000) return `${totalMs}ms`
	const seconds = totalMs / 1000
	if (seconds < 60) return `${seconds.toFixed(1)}s`
	const minutes = Math.floor(seconds / 60)
	const remainingSeconds = seconds % 60
	return `${minutes}m ${remainingSeconds.toFixed(0)}s`
}

export function ActionGroup({ category, entries, durations }: ActionGroupProps) {
	const [expanded, setExpanded] = useState(false)

	const total = entries.length
	const allDone = entries.every((e) => e.tool_response !== null)
	const [activeLabel, doneLabel, noun] = CATEGORY_LABELS[category] || [
		"Processing",
		"Processed",
		"items",
	]

	const tail = entries[entries.length - 1]
	const tailDuration = durations[durations.length - 1]
	const totalDuration = aggregateDuration(durations)

	// Header text with tense switching
	const headerText = allDone
		? `${doneLabel} ${total} ${noun}`
		: `${activeLabel} ${total} ${noun}...`

	return (
		<div className="tool-group">
			<div className="tool-group-header" onClick={() => setExpanded((v) => !v)}>
				{!allDone && <span className="spinner-inline" />}
				<span className="tool-group-label">{headerText}</span>
				<span className="tool-group-chevron">{expanded ? "\u25BC" : "\u25B6"}</span>
				{allDone && <Duration value={totalDuration} />}
			</div>

			{/* Expanded: show all items as one-liners */}
			{expanded && (
				<div className="tool-group-items">
					{entries.map((entry, i) => (
						<ToolExecution
							key={entry.tool_use_id || `gi-${i}`}
							entry={entry}
							duration={durations[i]}
						/>
					))}
				</div>
			)}

			{/* Tail: always show last/active item */}
			{!expanded && (
				<div className="tool-group-tail">
					<ToolExecution entry={tail} duration={tailDuration} />
				</div>
			)}
		</div>
	)
}
