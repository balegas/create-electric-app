import { useEffect, useRef } from "react"
import type { ConsoleEntry } from "../lib/event-types"
import {
	ConsoleLogEntry,
	ConsoleTextEntry,
	ConsoleThinkingEntry,
	ConsoleUserMessage,
} from "./ConsoleEntry"
import { GatePrompt } from "./GatePrompt"
import { ToolExecution } from "./ToolExecution"

interface ConsoleProps {
	sessionId: string
	entries: ConsoleEntry[]
	onGateResolved: (index: number) => void
}

function getEntryTs(entry: ConsoleEntry): string | undefined {
	if (entry.kind === "user_message") return undefined
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

export function Console({ sessionId, entries, onGateResolved }: ConsoleProps) {
	const bottomRef = useRef<HTMLDivElement>(null)
	const entriesLength = entries.length

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" })
	}, [entriesLength])

	// Pre-compute durations: time since the previous entry with a timestamp
	const durations: (string | null)[] = []
	let prevTs: string | null = null
	for (const entry of entries) {
		const ts = getEntryTs(entry)
		if (entry.kind === "user_message" || !ts) {
			durations.push(null)
		} else if (prevTs) {
			const ms = new Date(ts).getTime() - new Date(prevTs).getTime()
			durations.push(ms >= 0 ? formatDuration(ms) : null)
		} else {
			durations.push(null)
		}
		if (ts) prevTs = ts
	}

	return (
		<div className="console">
			{entries.map((entry, i) => {
				const duration = durations[i]
				switch (entry.kind) {
					case "log":
						return <ConsoleLogEntry key={`log-${i}`} entry={entry} duration={duration} />
					case "user_message":
						return <ConsoleUserMessage key={`user-${i}`} entry={entry} />
					case "tool":
						return (
							<ToolExecution
								key={entry.toolUseId || `tool-${i}`}
								entry={entry}
								duration={duration}
							/>
						)
					case "text":
						return <ConsoleTextEntry key={`text-${i}`} entry={entry} duration={duration} />
					case "thinking":
						return <ConsoleThinkingEntry key={`thinking-${i}`} entry={entry} duration={duration} />
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
			<div ref={bottomRef} />
		</div>
	)
}
