import { useCallback, useEffect, useRef, useState } from "react"
import type { ConsoleEntry, EngineEvent } from "../lib/event-types"
import { getSessionToken } from "../lib/session-store"

export interface SessionCost {
	totalCostUsd: number
	totalTurns: number
	totalDurationMs: number
}

export function useSession(sessionId: string | null) {
	const [entries, setEntries] = useState<ConsoleEntry[]>([])
	const [isLive, setIsLive] = useState(false)
	const [isComplete, setIsComplete] = useState(false)
	const [appStatus, setAppStatus] = useState<{
		status: "running" | "stopped"
		port?: number
		previewUrl?: string
	} | null>(null)
	const [cost, setCost] = useState<SessionCost>({
		totalCostUsd: 0,
		totalTurns: 0,
		totalDurationMs: 0,
	})
	const lastEventIdRef = useRef("-1")

	const processEvent = useCallback((event: EngineEvent) => {
		setEntries((prev) => {
			switch (event.type) {
				case "log":
					return [
						...prev,
						{ kind: "log" as const, level: event.level, message: event.message, ts: event.ts },
					]

				case "user_prompt":
					return [
						...prev,
						{ kind: "user_prompt" as const, message: event.message, sender: event.sender },
					]

				case "pre_tool_use":
					return [
						...prev,
						{
							kind: "tool_use" as const,
							tool_name: event.tool_name,
							tool_use_id: event.tool_use_id,
							tool_input: event.tool_input,
							tool_response: null,
							agent: event.agent,
							ts: event.ts,
						},
					]

				case "post_tool_use": {
					const updated = [...prev]
					for (let i = updated.length - 1; i >= 0; i--) {
						const entry = updated[i]
						if (entry.kind === "tool_use" && entry.tool_use_id === event.tool_use_id) {
							updated[i] = {
								...entry,
								tool_response: event.tool_response,
								agent: entry.agent || event.agent,
							}
							break
						}
					}
					return updated
				}

				case "post_tool_use_failure": {
					// Treat failures like post_tool_use but with the error as the response
					const updated = [...prev]
					for (let i = updated.length - 1; i >= 0; i--) {
						const entry = updated[i]
						if (entry.kind === "tool_use" && entry.tool_use_id === event.tool_use_id) {
							updated[i] = {
								...entry,
								tool_response: `Error: ${event.error}`,
								agent: entry.agent || event.agent,
							}
							break
						}
					}
					return updated
				}

				case "assistant_message":
					return [
						...prev,
						{
							kind: "assistant_message" as const,
							text: event.text,
							agent: event.agent,
							ts: event.ts,
						},
					]

				case "todo_write": {
					// Upsert: replace existing todo_widget if one exists, otherwise append
					const existingIdx = prev.findIndex((e) => e.kind === "todo_widget")
					const todoEntry = {
						kind: "todo_widget" as const,
						tool_use_id: event.tool_use_id,
						todos: event.todos,
						ts: event.ts,
					}
					if (existingIdx >= 0) {
						const updated = [...prev]
						updated[existingIdx] = todoEntry
						return updated
					}
					return [...prev, todoEntry]
				}

				case "ask_user_question":
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

				case "session_end":
				case "session_start":
				case "app_status":
					return prev

				default:
					return prev
			}
		})

		if (event.type === "app_status") {
			setAppStatus({
				status: event.status,
				port: event.port,
				previewUrl: event.previewUrl,
			})
		}
		if (event.type === "session_end") {
			setIsComplete(true)
			// Accumulate cost from each run
			if (event.cost_usd != null || event.num_turns != null || event.duration_ms != null) {
				setCost((prev) => ({
					totalCostUsd: prev.totalCostUsd + (event.cost_usd ?? 0),
					totalTurns: prev.totalTurns + (event.num_turns ?? 0),
					totalDurationMs: prev.totalDurationMs + (event.duration_ms ?? 0),
				}))
			}
		}
	}, [])

	useEffect(() => {
		if (!sessionId) return

		setEntries([])
		setIsLive(false)
		setIsComplete(false)
		setAppStatus(null)
		setCost({ totalCostUsd: 0, totalTurns: 0, totalDurationMs: 0 })
		lastEventIdRef.current = "-1"

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

			const token = getSessionToken(sessionId)
			const params = new URLSearchParams()
			if (token) params.set("token", token)
			// On reconnect, pass the last received offset so the server resumes
			// from where we left off instead of replaying from the beginning.
			if (lastEventIdRef.current !== "-1") {
				params.set("offset", lastEventIdRef.current)
			}
			const qs = params.toString()
			const sseUrl = `/api/sessions/${sessionId}/events${qs ? `?${qs}` : ""}`
			eventSource = new EventSource(sseUrl)

			eventSource.onopen = () => {
				if (!cancelled) {
					retryCount = 0 // Reset on successful connection
					setIsLive(true)
				}
			}

			eventSource.onmessage = (e) => {
				if (cancelled) return
				// Track the last received event ID so reconnects resume from here
				if (e.lastEventId) {
					lastEventIdRef.current = e.lastEventId
				}
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

	return { entries, isLive, isComplete, appStatus, cost, markGateResolved }
}
