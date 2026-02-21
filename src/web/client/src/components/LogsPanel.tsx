import { useState } from "react"
import type { ConsoleEntry, LogLevel } from "../lib/event-types"
import { ConsoleLogEntry } from "./ConsoleEntry"

interface LogsPanelProps {
	entries: ConsoleEntry[]
}

const LOG_LEVELS: LogLevel[] = [
	"plan",
	"approve",
	"task",
	"build",
	"fix",
	"done",
	"error",
	"verbose",
]

export function LogsPanel({ entries }: LogsPanelProps) {
	const [activeFilters, setActiveFilters] = useState<Set<LogLevel>>(new Set(LOG_LEVELS))

	const logEntries = entries.filter(
		(e): e is Extract<ConsoleEntry, { kind: "log" }> =>
			e.kind === "log" && activeFilters.has(e.level),
	)

	function toggleFilter(level: LogLevel) {
		setActiveFilters((prev) => {
			const next = new Set(prev)
			if (next.has(level)) {
				next.delete(level)
			} else {
				next.add(level)
			}
			return next
		})
	}

	return (
		<div className="logs-panel">
			<div className="logs-filters">
				{LOG_LEVELS.map((level) => (
					<button
						key={level}
						type="button"
						className={`logs-filter-btn ${activeFilters.has(level) ? "active" : ""}`}
						onClick={() => toggleFilter(level)}
					>
						{level}
					</button>
				))}
			</div>
			<div className="logs-list">
				{logEntries.length === 0 ? (
					<div className="right-panel-empty">No log entries</div>
				) : (
					logEntries.map((entry, i) => (
						<ConsoleLogEntry key={`log-${i}`} entry={entry} duration={null} />
					))
				)}
			</div>
		</div>
	)
}
