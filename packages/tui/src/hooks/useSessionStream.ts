import { useCallback, useEffect, useRef, useState } from "react"
import type { EngineEvent } from "@electric-agent/protocol"
import type { ElectricAgentClient } from "@electric-agent/protocol/client"

export type ConsoleEntry =
	| { kind: "log"; level: string; message: string; ts: string }
	| { kind: "user_prompt"; message: string; sender?: string }
	| {
			kind: "tool_use"
			tool_name: string
			tool_use_id: string
			tool_input: Record<string, unknown>
			tool_response: string | null
			agent?: string
			ts: string
	  }
	| { kind: "assistant_message"; text: string; agent?: string; ts: string }
	| {
			kind: "todo_widget"
			tool_use_id: string
			todos: Array<{ id: string; content: string; status: string; priority?: string }>
			ts: string
	  }
	| {
			kind: "gate"
			event: Extract<EngineEvent, { type: "infra_config_prompt" | "ask_user_question" | "outbound_message_gate" }>
			resolved: boolean
			resolvedSummary?: string
			resolvedDetails?: Record<string, string>
			ts: string
	  }

export function useSessionStream(client: ElectricAgentClient, sessionId: string | null) {
	const [entries, setEntries] = useState<ConsoleEntry[]>([])
	const [isLive, setIsLive] = useState(false)
	const [isComplete, setIsComplete] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [appStatus, setAppStatus] = useState<{
		status: "running" | "stopped"
		port?: number
		previewUrl?: string
	} | null>(null)
	const abortRef = useRef<AbortController | null>(null)

	const processEvent = useCallback((event: EngineEvent) => {
		setEntries((prev) => {
			switch (event.type) {
				case "log":
					return [...prev, { kind: "log" as const, level: event.level, message: event.message, ts: event.ts }]

				case "user_prompt":
					return [...prev, { kind: "user_prompt" as const, message: event.message, sender: event.sender }]

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
							updated[i] = { ...entry, tool_response: event.tool_response, agent: entry.agent || event.agent }
							break
						}
					}
					return updated
				}

				case "post_tool_use_failure": {
					const updated = [...prev]
					for (let i = updated.length - 1; i >= 0; i--) {
						const entry = updated[i]
						if (entry.kind === "tool_use" && entry.tool_use_id === event.tool_use_id) {
							updated[i] = { ...entry, tool_response: `Error: ${event.error}`, agent: entry.agent || event.agent }
							break
						}
					}
					return updated
				}

				case "assistant_message":
					return [...prev, { kind: "assistant_message" as const, text: event.text, agent: event.agent, ts: event.ts }]

				case "todo_write": {
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
				case "outbound_message_gate":
					return [...prev, { kind: "gate" as const, event: event as Extract<EngineEvent, { type: "infra_config_prompt" | "ask_user_question" | "outbound_message_gate" }>, resolved: false, ts: event.ts }]

				case "gate_resolved": {
					const updated = [...prev]
					for (let i = updated.length - 1; i >= 0; i--) {
						const entry = updated[i]
						if (entry.kind === "gate" && !entry.resolved) {
							updated[i] = {
								...entry,
								resolved: true,
								resolvedSummary: event.summary || entry.resolvedSummary,
								resolvedDetails: event.details,
							}
							break
						}
					}
					return updated
				}

				case "session_end":
				case "session_start":
				case "app_status":
				case "budget_exceeded":
				case "git_checkpoint":
				case "outbound_message_gate_resolved":
					return prev

				default:
					return prev
			}
		})

		if (event.type === "app_status") {
			setAppStatus({ status: event.status, port: event.port, previewUrl: event.previewUrl })
		}
		if (event.type === "user_prompt") {
			setIsComplete(false)
		}
		if (event.type === "session_end") {
			setIsComplete(true)
		}
	}, [])

	useEffect(() => {
		if (!sessionId) return

		setEntries([])
		setIsLive(false)
		setIsComplete(false)
		setAppStatus(null)
		setError(null)

		const abort = new AbortController()
		abortRef.current = abort

		async function connect() {
			try {
				const stream = client.sessionEvents(sessionId!, { signal: abort.signal })
				setIsLive(true)
				for await (const event of stream) {
					if (abort.signal.aborted) break
					processEvent(event)
				}
			} catch (err) {
				if (!abort.signal.aborted) {
					setIsLive(false)
					const msg = err instanceof Error ? err.message : "Stream connection failed"
					setError(msg)
				}
			}
		}

		connect()

		return () => {
			abort.abort()
			abortRef.current = null
		}
	}, [client, sessionId, processEvent])

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

	return { entries, isLive, isComplete, appStatus, markGateResolved, error }
}
