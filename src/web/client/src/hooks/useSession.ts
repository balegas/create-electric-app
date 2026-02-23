import { useCallback, useEffect, useRef, useState } from "react"
import toast from "react-hot-toast"
import type { ConsoleEntry, EngineEvent } from "../lib/event-types"

export function useSession(sessionId: string | null) {
	const [entries, setEntries] = useState<ConsoleEntry[]>([])
	const [isLive, setIsLive] = useState(false)
	const [isComplete, setIsComplete] = useState(false)
	const [appReady, setAppReady] = useState(false)
	const [totalCost, setTotalCost] = useState(0)
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
							agent: event.agent,
							ts: event.ts,
						},
					]

				case "tool_result": {
					const updated = [...prev]
					for (let i = updated.length - 1; i >= 0; i--) {
						const entry = updated[i]
						if (entry.kind === "tool" && entry.toolUseId === event.toolUseId) {
							updated[i] = {
								...entry,
								output: event.output,
								agent: entry.agent || event.agent,
							}
							break
						}
					}
					return updated
				}

				case "assistant_text":
					return [
						...prev,
						{ kind: "text" as const, text: event.text, agent: event.agent, ts: event.ts },
					]

				case "assistant_thinking":
					return [
						...prev,
						{
							kind: "thinking" as const,
							text: event.text,
							agent: event.agent,
							ts: event.ts,
						},
					]

				case "clarification_needed":
				case "plan_ready":
				case "continue_needed":
				case "infra_config_prompt":
					return [...prev, { kind: "gate" as const, event, resolved: false, ts: event.ts }]

				case "gate_resolved": {
					// Mark the most recent unresolved gate as resolved, or enrich an
					// already-resolved gate with details from the server (the client marks
					// infra_config resolved immediately via callback, before the SSE event
					// arrives with details).
					const updated = [...prev]
					let found = false
					for (let i = updated.length - 1; i >= 0; i--) {
						const entry = updated[i]
						if (entry.kind === "gate" && !entry.resolved) {
							updated[i] = {
								...entry,
								resolved: true,
								resolvedSummary: event.summary || entry.resolvedSummary,
								resolvedDetails: event.details,
							}
							found = true
							break
						}
					}
					if (!found && event.details) {
						for (let i = updated.length - 1; i >= 0; i--) {
							const entry = updated[i]
							if (entry.kind === "gate" && entry.resolved && !entry.resolvedDetails) {
								updated[i] = { ...entry, resolvedDetails: event.details }
								break
							}
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
		toastShownRef.current = false
		liveRef.current = false

		let cancelled = false
		let eventSource: EventSource | null = null
		let retryCount = 0
		const MAX_RETRIES = 10

		function connect() {
			if (cancelled) return
			if (retryCount >= MAX_RETRIES) {
				console.warn(`[sse] Giving up on session ${sessionId} after ${MAX_RETRIES} retries`)
				setIsLive(false)
				return
			}

			eventSource = new EventSource(`/api/sessions/${sessionId}/events`)

			eventSource.onopen = () => {
				if (!cancelled) {
					retryCount = 0 // Reset on successful connection
					setIsLive(true)
					// Mark live after connection — first batch of events is catch-up
					setTimeout(() => {
						liveRef.current = true
					}, 500)
				}
			}

			eventSource.onmessage = (e) => {
				if (cancelled) return
				try {
					const event = JSON.parse(e.data) as EngineEvent
					processEvent(event)
				} catch {
					// Ignore malformed events
				}
			}

			eventSource.onerror = () => {
				if (cancelled) return
				eventSource?.close()
				retryCount++
				// Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 30s
				const delay = Math.min(1000 * 2 ** (retryCount - 1), 30_000)
				setTimeout(connect, delay)
			}
		}

		connect()

		return () => {
			cancelled = true
			if (eventSource) {
				eventSource.close()
				eventSource = null
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
