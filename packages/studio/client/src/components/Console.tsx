import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ConsoleEntry } from "../lib/event-types"
import { ActionGroup, type ActionGroupEntry } from "./ActionGroup"
import { ConsoleLogEntry, ConsoleTextEntry, ConsoleUserMessage } from "./ConsoleEntry"
import { GatePrompt } from "./GatePrompt"
import { TodoWidget } from "./TodoWidget"
import { ToolExecution } from "./ToolExecution"

interface ConsoleProps {
	sessionId: string
	entries: ConsoleEntry[]
	isLive: boolean
	isComplete: boolean
	onGateResolved: (index: number, summary?: string) => void
}

/** Minimum action entries to trigger grouping. */
const GROUP_THRESHOLD = 3

/** Entries that are "actions" — tool calls between boundaries. */
function isActionEntry(entry: ConsoleEntry): boolean {
	return entry.kind === "tool_use"
}

/**
 * A render-ready item: either a single ConsoleEntry or a grouped run of actions.
 */
type RenderItem =
	| { type: "single"; entry: ConsoleEntry; index: number; duration: string | null }
	| { type: "group"; items: ActionGroupEntry[] }

/**
 * Walk the flat entries array and produce RenderItems, collapsing consecutive
 * action entries (tool_use) between boundary entries
 * into a single collapsible group showing just the tail.
 */
function buildRenderItems(entries: ConsoleEntry[], durations: (string | null)[]): RenderItem[] {
	const items: RenderItem[] = []
	let i = 0

	while (i < entries.length) {
		const entry = entries[i]

		if (isActionEntry(entry)) {
			// Collect consecutive action entries
			const run: ActionGroupEntry[] = []
			while (i < entries.length && isActionEntry(entries[i])) {
				run.push({ entry: entries[i], index: i, duration: durations[i] })
				i++
			}

			if (run.length >= GROUP_THRESHOLD) {
				items.push({ type: "group", items: run })
			} else {
				for (const item of run) {
					items.push({ type: "single", ...item })
				}
			}
			continue
		}

		items.push({ type: "single", entry, index: i, duration: durations[i] })
		i++
	}

	return items
}

function getEntryTs(entry: ConsoleEntry): string | undefined {
	if (entry.kind === "user_prompt") return undefined
	return entry.ts
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`
	const seconds = ms / 1000
	if (seconds < 60) return `${seconds.toFixed(1)}s`
	const minutes = Math.floor(seconds / 60)
	const remainingSeconds = seconds % 60
	return `${minutes}m ${remainingSeconds.toFixed(0)}s`
}

/**
 * Shows a pulsing "Waiting for response" indicator with a live elapsed timer.
 * Displayed when the agent is between API turns (no events arriving).
 */
function WaitingIndicator({ sinceTs }: { sinceTs: string }) {
	const [elapsed, setElapsed] = useState("")

	useEffect(() => {
		const origin = new Date(sinceTs).getTime()
		const tick = () => {
			const ms = Date.now() - origin
			setElapsed(formatDuration(Math.max(0, ms)))
		}
		tick()
		const id = setInterval(tick, 1000)
		return () => clearInterval(id)
	}, [sinceTs])

	return (
		<div className="console-entry waiting-indicator">
			<span className="spinner-inline" />
			<span className="waiting-label">Waiting for response...</span>
			<span className="duration">{elapsed}</span>
		</div>
	)
}

export function Console({ sessionId, entries, isLive, isComplete, onGateResolved }: ConsoleProps) {
	const containerRef = useRef<HTMLDivElement>(null)
	const bottomRef = useRef<HTMLDivElement>(null)
	const [isAtBottom, setIsAtBottom] = useState(true)
	const entriesLength = entries.length

	const scrollToBottom = useCallback(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" })
	}, [])

	const handleScroll = useCallback(() => {
		const el = containerRef.current
		if (!el) return
		const threshold = 80
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
		setIsAtBottom(atBottom)
	}, [])

	useEffect(() => {
		if (isAtBottom) {
			bottomRef.current?.scrollIntoView({ behavior: "smooth" })
		}
	}, [entriesLength, isAtBottom])

	// Pre-compute durations
	const durations: (string | null)[] = []
	let prevTs: string | null = null
	for (const entry of entries) {
		const ts = getEntryTs(entry)
		if (entry.kind === "user_prompt" || !ts) {
			durations.push(null)
		} else if (prevTs) {
			const ms = new Date(ts).getTime() - new Date(prevTs).getTime()
			durations.push(ms >= 0 ? formatDuration(ms) : null)
		} else {
			durations.push(null)
		}
		if (ts) prevTs = ts
	}

	// Build grouped render items
	const renderItems = useMemo(() => buildRenderItems(entries, durations), [entries, durations])

	// Determine whether to show the waiting indicator:
	// Show when the session is live, not complete, and no tool is currently loading
	// or waiting on a gate. Don't show after assistant_message (Stop hook) —
	// that means the turn ended and Claude is waiting for the next user prompt.
	let showWaiting = false
	let waitingSinceTs = ""
	if (isLive && !isComplete && entries.length > 0) {
		const last = entries[entries.length - 1]
		const hasLoadingTool = last.kind === "tool_use" && last.tool_response === null
		const hasUnresolvedGate = last.kind === "gate" && !last.resolved
		const turnEnded = last.kind === "assistant_message"
		if (!hasLoadingTool && !hasUnresolvedGate && !turnEnded) {
			showWaiting = true
			waitingSinceTs = prevTs || new Date().toISOString()
		}
	}

	return (
		<div className="console" ref={containerRef} onScroll={handleScroll}>
			{renderItems.map((item) => {
				if (item.type === "group") {
					return <ActionGroup key={`group-${item.items[0].index}`} items={item.items} />
				}

				const { entry, index: i, duration } = item
				switch (entry.kind) {
					case "log":
						return <ConsoleLogEntry key={`log-${i}`} entry={entry} duration={duration} />
					case "user_prompt":
						return <ConsoleUserMessage key={`user-${i}`} entry={entry} />
					case "tool_use":
						return (
							<ToolExecution
								key={entry.tool_use_id || `tool-${i}`}
								entry={entry}
								duration={duration}
							/>
						)
					case "assistant_message":
						return <ConsoleTextEntry key={`text-${i}`} entry={entry} duration={duration} />
					case "todo_widget":
						return <TodoWidget key={`todo-${i}`} entry={entry} />
					case "gate":
						return (
							<GatePrompt
								key={`gate-${i}`}
								sessionId={sessionId}
								entry={entry}
								entryIndex={i}
								onResolved={onGateResolved}
								duration={duration}
							/>
						)
					default:
						return null
				}
			})}
			{showWaiting && <WaitingIndicator sinceTs={waitingSinceTs} />}
			<div ref={bottomRef} />
			{!isAtBottom && (
				<button type="button" className="jump-to-bottom" onClick={scrollToBottom}>
					Jump to latest
				</button>
			)}
		</div>
	)
}
