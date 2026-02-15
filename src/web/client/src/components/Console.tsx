import { useEffect, useRef } from "react"
import type { ConsoleEntry } from "../lib/event-types"
import { ConsoleLogEntry, ConsoleTextEntry, ConsoleUserMessage } from "./ConsoleEntry"
import { GatePrompt } from "./GatePrompt"
import { ToolExecution } from "./ToolExecution"

interface ConsoleProps {
	sessionId: string
	entries: ConsoleEntry[]
	onGateResolved: (index: number) => void
}

export function Console({ sessionId, entries, onGateResolved }: ConsoleProps) {
	const bottomRef = useRef<HTMLDivElement>(null)
	const entriesLength = entries.length

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" })
	}, [entriesLength])

	return (
		<div className="console">
			{entries.map((entry, i) => {
				switch (entry.kind) {
					case "log":
						return <ConsoleLogEntry key={`log-${i}`} entry={entry} />
					case "user_message":
						return <ConsoleUserMessage key={`user-${i}`} entry={entry} />
					case "tool":
						return <ToolExecution key={entry.toolUseId || `tool-${i}`} entry={entry} />
					case "text":
						return <ConsoleTextEntry key={`text-${i}`} entry={entry} />
					case "gate":
						return (
							<GatePrompt
								key={`gate-${i}`}
								sessionId={sessionId}
								entry={entry}
								entryIndex={i}
								onResolved={onGateResolved}
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
