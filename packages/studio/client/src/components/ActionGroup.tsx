import { useState } from "react"
import type { ConsoleEntry } from "../lib/event-types"
import { Duration } from "./ConsoleEntry"
import { ToolExecution } from "./ToolExecution"

type ToolEntry = Extract<ConsoleEntry, { kind: "tool_use" }>

export interface ActionGroupEntry {
	entry: ConsoleEntry
	index: number
	duration: string | null
}

interface ActionGroupProps {
	items: ActionGroupEntry[]
}

function aggregateDuration(items: ActionGroupEntry[]): string | null {
	let totalMs = 0
	let any = false
	for (const { duration: d } of items) {
		if (!d) continue
		any = true
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
	if (seconds < 60) return `${seconds.toFixed(0)}s`
	const minutes = Math.floor(seconds / 60)
	const remainingSeconds = seconds % 60
	return `${minutes}m ${remainingSeconds.toFixed(0)}s`
}

function countLabel(items: ActionGroupEntry[]): string {
	const toolCount = items.filter((i) => i.entry.kind === "tool_use").length
	const allDone = items
		.filter((i) => i.entry.kind === "tool_use")
		.every((i) => (i.entry as ToolEntry).tool_response !== null)

	if (allDone) {
		return `${toolCount} action${toolCount !== 1 ? "s" : ""}`
	}
	return `${toolCount} action${toolCount !== 1 ? "s" : ""}...`
}

export function ActionGroup({ items }: ActionGroupProps) {
	const [expanded, setExpanded] = useState(false)

	const toolItems = items.filter((i) => i.entry.kind === "tool_use")
	const allDone = toolItems.every((i) => (i.entry as ToolEntry).tool_response !== null)
	const tailItems = toolItems.slice(-3)
	const totalDuration = aggregateDuration(items)

	return (
		<div className="tool-group">
			<div className="tool-group-header" onClick={() => setExpanded((v) => !v)}>
				{!allDone && <span className="spinner-inline" />}
				<span className="tool-group-label">{countLabel(items)}</span>
				<span className="tool-group-chevron">{expanded ? "\u25BC" : "\u25B6"}</span>
				{allDone && <Duration value={totalDuration} />}
			</div>

			{expanded && (
				<div className="tool-group-items">
					{items.map(({ entry, index: i, duration }) => {
						if (entry.kind === "tool_use") {
							return (
								<ToolExecution
									key={entry.tool_use_id || `gi-${i}`}
									entry={entry}
									duration={duration}
								/>
							)
						}
						return null
					})}
				</div>
			)}

			{!expanded && tailItems.length > 0 && (
				<div className="tool-group-tail">
					{tailItems.map(({ entry, index: i, duration }) =>
						entry.kind === "tool_use" ? (
							<ToolExecution
								key={entry.tool_use_id || `gt-${i}`}
								entry={entry as ToolEntry}
								duration={duration}
							/>
						) : null,
					)}
				</div>
			)}
		</div>
	)
}
