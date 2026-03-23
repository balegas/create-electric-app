import { useEffect, useRef, useState } from "react"
import type { RoomEvent } from "@electric-agent/protocol"
import type { ElectricAgentClient } from "@electric-agent/protocol/client"

export interface RoomMessage {
	type: "agent_message"
	from: string
	to?: string
	body: string
	ts: string
}

export function useRoomStream(client: ElectricAgentClient, roomId: string | null) {
	const [events, setEvents] = useState<RoomEvent[]>([])
	const [isLive, setIsLive] = useState(false)
	const abortRef = useRef<AbortController | null>(null)

	useEffect(() => {
		if (!roomId) return

		setEvents([])
		setIsLive(false)

		const abort = new AbortController()
		abortRef.current = abort

		async function connect() {
			try {
				const stream = client.roomEvents(roomId!, { signal: abort.signal })
				setIsLive(true)
				for await (const event of stream) {
					if (abort.signal.aborted) break
					setEvents((prev) => [...prev, event])
				}
			} catch (err) {
				if (!abort.signal.aborted) {
					setIsLive(false)
				}
			}
		}

		connect()

		return () => {
			abort.abort()
			abortRef.current = null
		}
	}, [client, roomId])

	const messages = events.filter(
		(e): e is RoomEvent & { type: "agent_message" } => e.type === "agent_message",
	)

	const isClosed = events.some((e) => e.type === "room_closed")

	return { events, messages, isLive, isClosed }
}
