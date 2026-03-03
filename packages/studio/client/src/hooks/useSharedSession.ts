import type { Participant, SharedSessionEvent } from "@electric-agent/protocol"
import { useCallback, useEffect, useRef, useState } from "react"
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

		case "participant_joined": {
			// Deduplicate by participant id
			const exists = state.participants.some((p) => p.id === event.participant.id)
			if (exists) return state
			return { ...state, participants: [...state.participants, event.participant] }
		}

		case "participant_left":
			return {
				...state,
				participants: state.participants.filter((p) => p.id !== event.participantId),
			}

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

	return { ...state, isLive }
}
