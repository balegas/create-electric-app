import { stream } from "@durable-streams/client"
import { useCallback, useEffect, useRef, useState } from "react"
import type { ConsoleEntry, EngineEvent } from "../lib/event-types"

const STREAMS_BASE = "http://127.0.0.1:4437"

export function useSession(sessionId: string | null) {
	const [entries, setEntries] = useState<ConsoleEntry[]>([])
	const [isLive, setIsLive] = useState(false)
	const [isComplete, setIsComplete] = useState(false)
	const cancelRef = useRef<(() => void) | null>(null)
	const offsetRef = useRef<string>("-1")

	const processEvent = useCallback((event: EngineEvent) => {
		setEntries((prev) => {
			switch (event.type) {
				case "log":
					return [
						...prev,
						{ kind: "log" as const, level: event.level, message: event.message, ts: event.ts },
					]

				case "user_message":
					return [...prev, { kind: "user_message" as const, message: event.message }]

				case "tool_start":
					return [
						...prev,
						{
							kind: "tool" as const,
							toolName: event.toolName,
							toolUseId: event.toolUseId,
							input: event.input,
							output: null,
							ts: event.ts,
						},
					]

				case "tool_result": {
					// Find and update the matching tool entry
					const updated = [...prev]
					for (let i = updated.length - 1; i >= 0; i--) {
						const entry = updated[i]
						if (entry.kind === "tool" && entry.toolUseId === event.toolUseId) {
							updated[i] = { ...entry, output: event.output }
							break
						}
					}
					return updated
				}

				case "assistant_text":
					return [...prev, { kind: "text" as const, text: event.text, ts: event.ts }]

				case "clarification_needed":
				case "plan_ready":
				case "continue_needed":
					return [...prev, { kind: "gate" as const, event, resolved: false, ts: event.ts }]

				case "session_complete":
					return prev

				case "phase_complete":
					return prev

				default:
					return prev
			}
		})

		if (event.type === "session_complete") {
			setIsComplete(true)
		}
	}, [])

	useEffect(() => {
		if (!sessionId) return

		// Reset state — always replay from the beginning so we get the full history
		setEntries([])
		setIsLive(false)
		setIsComplete(false)
		offsetRef.current = "-1"

		let cancelled = false

		async function connect() {
			try {
				const res = await stream<EngineEvent>({
					url: `${STREAMS_BASE}/session/${sessionId}`,
					offset: offsetRef.current,
					live: true,
				})

				cancelRef.current = () => res.cancel()
				if (cancelled) {
					res.cancel()
					return
				}

				setIsLive(true)

				res.subscribeJson(async (batch) => {
					if (cancelled) return
					for (const item of batch.items) {
						processEvent(item)
					}
					offsetRef.current = batch.offset
				})
			} catch {
				// Stream may not exist yet, retry after a delay
				if (!cancelled) {
					setTimeout(connect, 1000)
				}
			}
		}

		connect()

		return () => {
			cancelled = true
			if (cancelRef.current) {
				cancelRef.current()
				cancelRef.current = null
			}
		}
	}, [sessionId, processEvent])

	const markGateResolved = useCallback((index: number) => {
		setEntries((prev) => {
			const updated = [...prev]
			const entry = updated[index]
			if (entry?.kind === "gate") {
				updated[index] = { ...entry, resolved: true }
			}
			return updated
		})
	}, [])

	return { entries, isLive, isComplete, markGateResolved }
}
