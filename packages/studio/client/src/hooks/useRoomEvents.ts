import { useEffect, useState } from "react"
import { client } from "../lib/api"

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

	useEffect(() => {
		if (!roomId) return

		setEvents([])
		setIsLive(false)

		const abort = new AbortController()

		async function connect() {
			try {
				const stream = client.roomEvents(roomId!, { signal: abort.signal })
				setIsLive(true)
				for await (const event of stream) {
					if (abort.signal.aborted) break
					setEvents((prev) => [...prev, event as unknown as RoomEvent])
				}
			} catch {
				if (!abort.signal.aborted) {
					setIsLive(false)
				}
			}
		}

		connect()
		return () => {
			abort.abort()
		}
	}, [roomId])

	const messages = events.filter(
		(e): e is RoomEvent & { type: "agent_message" } => e.type === "agent_message",
	)

	const isClosed = events.some((e) => e.type === "room_closed")

	return { events, messages, isLive, isClosed }
}
