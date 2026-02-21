import { useState } from "react"
import type { ConsoleEntry } from "../lib/event-types"
import { ToolExecution } from "./ToolExecution"

type ToolEntry = Extract<ConsoleEntry, { kind: "tool" }>

interface ActionGroupProps {
	entries: ToolEntry[]
	durations: (string | null)[]
}

function getToolSummary(entry: ToolEntry): string {
	const { toolName, input } = entry
	if (toolName === "Write" || toolName === "Edit") {
		return (input.file_path as string) || "unknown file"
	}
	if (toolName === "Read") {
		return (input.file_path as string) || "unknown file"
	}
	if (toolName === "Bash") {
		return ((input.command as string) || "").slice(0, 60)
	}
	if (toolName === "Glob") {
		return (input.pattern as string) || "*"
	}
	if (toolName === "Grep") {
		return (input.pattern as string) || ""
	}
	return toolName
}

function getStatus(entry: ToolEntry, isLast: boolean): "pending" | "running" | "done" | "failed" {
	if (entry.output === null) {
		return isLast ? "running" : "pending"
	}
	// Simple heuristic: check if output contains error indicators
	const out = entry.output.toLowerCase()
	if (out.includes("error:") || out.includes("failed") || out.startsWith("error")) {
		return "failed"
	}
	return "done"
}

function StatusIcon({ status }: { status: string }) {
	switch (status) {
		case "pending":
			return (
				<span className="status-icon">
					<span className="status-icon-pending" />
				</span>
			)
		case "running":
			return (
				<span className="status-icon">
					<span className="status-icon-running" />
				</span>
			)
		case "done":
			return <span className="status-icon status-icon-done">{"\u2713"}</span>
		case "failed":
			return <span className="status-icon status-icon-failed">{"\u2717"}</span>
		default:
			return null
	}
}

export function ActionGroup({ entries, durations }: ActionGroupProps) {
	const [collapsed, setCollapsed] = useState(false)
	const [expandedIdx, setExpandedIdx] = useState<number | null>(null)

	const doneCount = entries.filter((e) => e.output !== null).length
	const total = entries.length
	const allDone = doneCount === total

	return (
		<div className="action-group">
			<div className="action-group-header" onClick={() => setCollapsed((v) => !v)}>
				<span className="action-group-title">Actions</span>
				<span className="action-group-count">
					{allDone ? `${total} complete` : `${doneCount} of ${total} complete`}
				</span>
				<span className="action-group-toggle">{collapsed ? "\u25B6" : "\u25BC"}</span>
			</div>

			{!collapsed && (
				<div className="action-group-list">
					{entries.map((entry, i) => {
						const isLast = i === entries.length - 1
						const status = getStatus(entry, isLast)
						const isExpanded = expandedIdx === i

						return (
							<div key={entry.toolUseId || `action-${i}`}>
								<div
									className={`action-item ${isExpanded ? "expanded" : ""}`}
									onClick={() => setExpandedIdx(isExpanded ? null : i)}
								>
									<StatusIcon status={status} />
									<span className="action-item-name">{entry.toolName}</span>
									<span className="action-item-summary">{getToolSummary(entry)}</span>
									{durations[i] && <span className="action-item-duration">{durations[i]}</span>}
								</div>
								{isExpanded && (
									<div className="action-item-detail">
										<ToolExecution entry={entry} duration={durations[i]} />
									</div>
								)}
							</div>
						)
					})}
				</div>
			)}
		</div>
	)
}
