const STORAGE_KEY = "electric-agent:agent-rooms"

export interface AgentRoomEntry {
	id: string
	code: string
	name: string
	createdAt: string
}

export function getAgentRooms(): AgentRoomEntry[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY)
		if (!raw) return []
		return JSON.parse(raw) as AgentRoomEntry[]
	} catch {
		return []
	}
}

export function addAgentRoom(entry: AgentRoomEntry): void {
	const rooms = getAgentRooms()
	const filtered = rooms.filter((r) => r.id !== entry.id)
	filtered.push(entry)
	localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered))
}

export function removeAgentRoom(roomId: string): void {
	const rooms = getAgentRooms()
	const filtered = rooms.filter((r) => r.id !== roomId)
	localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered))
}
