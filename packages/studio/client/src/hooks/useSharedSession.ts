import type { Participant, SharedSessionEvent } from "@electric-agent/protocol"
import { useCallback, useEffect, useRef, useState } from "react"
import { getRoomPresence, pingRoom } from "../lib/api"
import { getRoomToken } from "../lib/session-store"

export interface SharedSessionState {
	name: string
	code: string
	participants: Participant[]
	sessionIds: string[]
	/** Maps sessionId → display name (from session_linked events) */
	sessionNames: Map<string, string>
	revoked: boolean
}

const initialState: SharedSessionState = {
	name: "",
	code: "",
	participants: [],
	sessionIds: [],
	sessionNames: new Map(),
	revoked: false,
}

function reduceEvent(state: SharedSessionState, event: SharedSessionEvent): SharedSessionState {
	switch (event.type) {
		case "shared_session_created":
			return { ...state, name: event.name, code: event.code }

		case "participant_joined":
		case "participant_left":
			// Presence is now managed via ping/polling, ignore stream join/leave events
			return state

		case "session_linked": {
			if (state.sessionIds.includes(event.sessionId)) return state
			const names = new Map(state.sessionNames)
			if (event.sessionName) {
				names.set(event.sessionId, event.sessionName)
			}
			return {
				...state,
				sessionIds: [...state.sessionIds, event.sessionId],
				sessionNames: names,
			}
		}

		case "session_unlinked": {
			const names = new Map(state.sessionNames)
			names.delete(event.sessionId)
			return {
				...state,
				sessionIds: state.sessionIds.filter((id) => id !== event.sessionId),
				sessionNames: names,
			}
		}

		case "code_revoked":
			return { ...state, revoked: true }

		default:
			return state
	}
}

const PING_INTERVAL_MS = 30_000
const PRESENCE_POLL_MS = 30_000

export function useSharedSession(sharedSessionId: string | null) {
	const [state, setState] = useState<SharedSessionState>(initialState)
	const [isLive, setIsLive] = useState(false)
	const stateRef = useRef(initialState)
	const lastEventIdRef = useRef("-1")

	const processEvent = useCallback((event: SharedSessionEvent) => {
		const next = reduceEvent(stateRef.current, event)
		stateRef.current = next
		setState(next)
	}, [])

	// SSE connection for room events (session links, revocations, etc.)
	useEffect(() => {
		if (!sharedSessionId) return

		setState(initialState)
		stateRef.current = initialState
		setIsLive(false)
		lastEventIdRef.current = "-1"

		let cancelled = false
		let eventSource: EventSource | null = null
		let retryCount = 0
		const MAX_RETRIES = 10

		function connect() {
			if (cancelled) return
			if (retryCount >= MAX_RETRIES) {
				setIsLive(false)
				return
			}

			const roomTokenValue = getRoomToken(sharedSessionId)
			const params = new URLSearchParams()
			if (roomTokenValue) params.set("token", roomTokenValue)
			if (lastEventIdRef.current !== "-1") {
				params.set("offset", lastEventIdRef.current)
			}
			const qs = params.toString()
			const sseUrl = `/api/shared-sessions/${sharedSessionId}/events${qs ? `?${qs}` : ""}`
			eventSource = new EventSource(sseUrl)

			eventSource.onopen = () => {
				if (!cancelled) {
					retryCount = 0
					setIsLive(true)
				}
			}

			eventSource.onmessage = (e) => {
				if (cancelled) return
				if (e.lastEventId) {
					lastEventIdRef.current = e.lastEventId
				}
				try {
					const event = JSON.parse(e.data) as SharedSessionEvent
					processEvent(event)
				} catch {
					// Ignore malformed events
				}
			}

			eventSource.onerror = () => {
				if (cancelled) return
				eventSource?.close()
				retryCount++
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
	}, [sharedSessionId, processEvent])

	// Ping heartbeat + presence polling
	useEffect(() => {
		if (!sharedSessionId) return

		let cancelled = false

		async function tick() {
			if (cancelled) return
			try {
				await pingRoom(sharedSessionId as string)
				const { participants } = await getRoomPresence(sharedSessionId as string)
				if (!cancelled) {
					setState((prev) => ({ ...prev, participants }))
					stateRef.current = { ...stateRef.current, participants }
				}
			} catch {
				// Best effort
			}
		}

		// Initial ping + presence fetch
		tick()
		const interval = setInterval(tick, Math.min(PING_INTERVAL_MS, PRESENCE_POLL_MS))

		return () => {
			cancelled = true
			clearInterval(interval)
		}
	}, [sharedSessionId])

	return { ...state, isLive }
}
