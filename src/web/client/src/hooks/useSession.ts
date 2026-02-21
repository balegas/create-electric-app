import { stream } from "@durable-streams/client"
import { useCallback, useEffect, useRef, useState } from "react"
import toast from "react-hot-toast"
import type { ConsoleEntry, EngineEvent } from "../lib/event-types"

const STREAMS_BASE = "http://127.0.0.1:4437"

export function useSession(sessionId: string | null) {
	const [entries, setEntries] = useState<ConsoleEntry[]>([])
	const [isLive, setIsLive] = useState(false)
	const [isComplete, setIsComplete] = useState(false)
	const [appReady, setAppReady] = useState(false)
	const [totalCost, setTotalCost] = useState(0)
	const cancelRef = useRef<(() => void) | null>(null)
	const offsetRef = useRef<string>("-1")
	const toastShownRef = useRef(false)
	const liveRef = useRef(false)

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

				case "assistant_thinking":
					return [...prev, { kind: "thinking" as const, text: event.text, ts: event.ts }]

				case "clarification_needed":
				case "plan_ready":
				case "continue_needed":
				case "infra_config_prompt":
					return [...prev, { kind: "gate" as const, event, resolved: false, ts: event.ts }]

				case "gate_resolved": {
					// Mark the most recent unresolved gate as resolved
					const updated = [...prev]
					for (let i = updated.length - 1; i >= 0; i--) {
						const entry = updated[i]
						if (entry.kind === "gate" && !entry.resolved) {
							updated[i] = {
								...entry,
								resolved: true,
								resolvedSummary: event.summary || entry.resolvedSummary,
							}
							break
						}
					}
					return updated
				}

				case "cost_update":
				case "session_complete":
				case "phase_complete":
				case "app_ready":
					return prev

				default:
					return prev
			}
		})

		if (event.type === "cost_update") {
			setTotalCost((prev) => prev + event.totalCostUsd)
		}
		if (event.type === "app_ready") {
			setAppReady(true)
		}
		if (event.type === "session_complete") {
			setIsComplete(true)
			// Only toast for live events (not replayed catch-up), and only once per session
			if (liveRef.current && !toastShownRef.current) {
				toastShownRef.current = true
				if (event.success) {
					toast.success("Session completed successfully")
				} else {
					toast.error("Session completed with errors")
				}
			}
		}
	}, [])

	useEffect(() => {
		if (!sessionId) return

		setEntries([])
		setIsLive(false)
		setIsComplete(false)
		setAppReady(false)
		setTotalCost(0)
		offsetRef.current = "-1"
		toastShownRef.current = false
		liveRef.current = false

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
				let firstBatch = true

				res.subscribeJson(async (batch) => {
					if (cancelled) return
					for (const item of batch.items) {
						processEvent(item)
					}
					offsetRef.current = batch.offset
					// Mark live after processing the first (catch-up) batch
					if (firstBatch) {
						firstBatch = false
						liveRef.current = true
					}
				})
			} catch {
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

	const markGateResolved = useCallback((index: number, summary?: string) => {
		setEntries((prev) => {
			const updated = [...prev]
			const entry = updated[index]
			if (entry?.kind === "gate") {
				updated[index] = { ...entry, resolved: true, resolvedSummary: summary }
			}
			return updated
		})
	}, [])

	return { entries, isLive, isComplete, appReady, totalCost, markGateResolved }
}
