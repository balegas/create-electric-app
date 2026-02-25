import type { Participant, SharedSessionEvent } from "@electric-agent/protocol"
import { useCallback, useEffect, useRef, useState } from "react"

export interface SharedSessionState {
	name: string
	code: string
	participants: Participant[]
	sessionIds: string[]
	revoked: boolean
}

const initialState: SharedSessionState = {
	name: "",
	code: "",
	participants: [],
	sessionIds: [],
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
			return { ...state, sessionIds: [...state.sessionIds, event.sessionId] }
		}

		case "session_unlinked":
			return {
				...state,
				sessionIds: state.sessionIds.filter((id) => id !== event.sessionId),
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

			eventSource = new EventSource(`/api/shared-sessions/${sharedSessionId}/events`)

			eventSource.onopen = () => {
				if (!cancelled) {
					retryCount = 0
					setIsLive(true)
				}
			}

			eventSource.onmessage = (e) => {
				if (cancelled) return
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
