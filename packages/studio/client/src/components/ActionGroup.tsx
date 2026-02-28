import { useEffect, useRef, useState } from "react"
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

/** How many tail items to show when collapsed. */
const VISIBLE_TAIL = 4

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
	const prevCountRef = useRef(entries.length)
	const tailRef = useRef<HTMLDivElement>(null)

	const total = entries.length
	const allDone = entries.every((e) => e.tool_response !== null)
	const [activeLabel, doneLabel, noun] = CATEGORY_LABELS[category] || [
		"Processing",
		"Processed",
		"items",
	]

	const totalDuration = aggregateDuration(durations)

	// Header text with tense switching
	const headerText = allDone
		? `${doneLabel} ${total} ${noun}`
		: `${activeLabel} ${total} ${noun}...`

	// Animate when a new entry is added while collapsed
	useEffect(() => {
		if (entries.length > prevCountRef.current && !expanded && tailRef.current) {
			const items = tailRef.current.querySelectorAll(".tool-group-tail-item")
			const lastItem = items[items.length - 1]
			if (lastItem) {
				lastItem.classList.remove("tool-group-slide-in")
				// Force reflow so animation restarts
				void (lastItem as HTMLElement).offsetWidth
				lastItem.classList.add("tool-group-slide-in")
			}
		}
		prevCountRef.current = entries.length
	}, [entries.length, expanded])

	// Visible tail entries (last VISIBLE_TAIL items)
	const tailStart = Math.max(0, entries.length - VISIBLE_TAIL)
	const tailEntries = entries.slice(tailStart)
	const tailDurations = durations.slice(tailStart)

	return (
		<div className="tool-group">
			<div className="tool-group-header" onClick={() => setExpanded((v) => !v)}>
				{!allDone && <span className="spinner-inline" />}
				<span className="tool-group-label">{headerText}</span>
				{allDone && <Duration value={totalDuration} />}
			</div>

			{/* Expanded: show all items */}
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

			{/* Collapsed: show last VISIBLE_TAIL items */}
			{!expanded && (
				<div className="tool-group-tail" ref={tailRef}>
					{tailEntries.map((entry, i) => (
						<div
							key={entry.tool_use_id || `gt-${tailStart + i}`}
							className={`tool-group-tail-item${i === tailEntries.length - 1 ? " tool-group-slide-in" : ""}`}
						>
							<ToolExecution entry={entry} duration={tailDurations[i]} />
						</div>
					))}
				</div>
			)}
		</div>
	)
}
