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
		return `${toolCount} tool${toolCount !== 1 ? "s" : ""}`
	}
	return `${toolCount} tool${toolCount !== 1 ? "s" : ""}...`
}

export function ActionGroup({ items }: ActionGroupProps) {
	const [expanded, setExpanded] = useState(false)
	const toolItems = items.filter((i) => i.entry.kind === "tool_use")
	const allDone = toolItems.every((i) => (i.entry as ToolEntry).tool_response !== null)
	const totalDuration = aggregateDuration(items)

	// Small groups: show all tools inline, no collapsing
	if (toolItems.length <= 3) {
		return (
			<div className="tool-group">
				{toolItems.map(({ entry, index: i, duration }) => (
					<ToolExecution
						key={entry.tool_use_id || `gi-${i}`}
						entry={entry as ToolEntry}
						duration={duration}
					/>
				))}
			</div>
		)
	}

	// Larger groups: collapsible with header, always showing last 3
	const TAIL_COUNT = 3
	const hiddenItems = toolItems.slice(0, -TAIL_COUNT)
	const tailItems = toolItems.slice(-TAIL_COUNT)

	return (
		<div className="tool-group">
			{hiddenItems.length > 0 && (
				<div className="tool-group-header" onClick={() => setExpanded((v) => !v)}>
					{!allDone && <span className="spinner-inline" />}
					<span className="tool-group-label">
						{expanded ? "\u25BC" : "\u25B6"} {hiddenItems.length} more tool
						{hiddenItems.length !== 1 ? "s" : ""}
					</span>
					{allDone && <Duration value={totalDuration} />}
				</div>
			)}

			{expanded && (
				<div className="tool-group-items">
					{hiddenItems.map(({ entry, index: i, duration }) => (
						<ToolExecution
							key={(entry as ToolEntry).tool_use_id || `gi-${i}`}
							entry={entry as ToolEntry}
							duration={duration}
						/>
					))}
				</div>
			)}

			{tailItems.map(({ entry, index: i, duration }) => (
				<ToolExecution
					key={(entry as ToolEntry).tool_use_id || `gt-${i}`}
					entry={entry as ToolEntry}
					duration={duration}
				/>
			))}
		</div>
	)
}
