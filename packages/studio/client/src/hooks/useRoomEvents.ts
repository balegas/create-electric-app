import type { SharedSessionEvent } from "@electric-agent/protocol"
import { useEffect, useRef, useState } from "react"

export interface RoomMessage {
	type: "agent_message"
	from: string
	to?: string
	body: string
	ts: string
}

export interface RoomEvent {
	type: string
	ts: string
	// agent_message
	from?: string
	to?: string
	body?: string
	// participant_joined
	participant?: { id: string; displayName: string }
	// participant_left
	participantId?: string
	// room_closed
	closedBy?: string
	summary?: string
}

export function useRoomEvents(roomId: string | null) {
	const [events, setEvents] = useState<RoomEvent[]>([])
	const [isLive, setIsLive] = useState(false)
	const lastEventIdRef = useRef("-1")

	useEffect(() => {
		if (!roomId) return

		setEvents([])
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

			const params = new URLSearchParams()
			if (lastEventIdRef.current !== "-1") {
				params.set("offset", lastEventIdRef.current)
			}
			const qs = params.toString()
			const sseUrl = `/api/rooms/${roomId}/events${qs ? `?${qs}` : ""}`
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
					setEvents((prev) => [...prev, event as unknown as RoomEvent])
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
	}, [roomId])

	const messages = events.filter(
		(e): e is RoomEvent & { type: "agent_message" } => e.type === "agent_message",
	)

	const isClosed = events.some((e) => e.type === "room_closed")

	return { events, messages, isLive, isClosed }
}
