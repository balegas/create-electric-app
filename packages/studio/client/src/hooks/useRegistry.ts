import { useCallback, useEffect, useRef, useState } from "react"
import type { RegistryEvent, RegistryRoomInfo, RegistrySessionInfo } from "../lib/event-types"

export function useRegistry() {
	const [sessions, setSessions] = useState<RegistrySessionInfo[]>([])
	const [rooms, setRooms] = useState<RegistryRoomInfo[]>([])
	const [isLive, setIsLive] = useState(false)

	// Keep maps in refs for efficient event processing
	const sessionsRef = useRef(new Map<string, RegistrySessionInfo>())
	const roomsRef = useRef(new Map<string, RegistryRoomInfo>())

	const flush = useCallback(() => {
		setSessions(Array.from(sessionsRef.current.values()))
		setRooms(Array.from(roomsRef.current.values()))
	}, [])

	useEffect(() => {
		let cancelled = false
		let eventSource: EventSource | null = null
		let retryCount = 0
		const MAX_RETRIES = 10

		function connect() {
			if (cancelled) return
			if (retryCount >= MAX_RETRIES) {
				console.warn("[registry-sse] Giving up after max retries")
				setIsLive(false)
				return
			}

			eventSource = new EventSource("/api/registry/events")

			eventSource.onopen = () => {
				if (!cancelled) {
					retryCount = 0
					setIsLive(true)
				}
			}

			eventSource.onmessage = (e) => {
				if (cancelled) return
				try {
					const event = JSON.parse(e.data) as RegistryEvent
					switch (event.type) {
						case "session_registered":
							sessionsRef.current.set(event.session.id, event.session)
							break
						case "session_updated": {
							const existing = sessionsRef.current.get(event.sessionId)
							if (existing) {
								sessionsRef.current.set(event.sessionId, {
									...existing,
									...event.update,
								})
							}
							break
						}
						case "session_deleted":
							sessionsRef.current.delete(event.sessionId)
							break
						case "room_created":
							roomsRef.current.set(event.room.id, event.room)
							break
						case "room_revoked": {
							const room = roomsRef.current.get(event.roomId)
							if (room) {
								roomsRef.current.set(event.roomId, {
									...room,
									revoked: true,
								})
							}
							break
						}
					}
					flush()
				} catch {
					// Ignore malformed events
				}
			}

			eventSource.onerror = () => {
				if (cancelled) return
				eventSource?.close()
				setIsLive(false)
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
	}, [flush])

	return { sessions, rooms, isLive }
}
