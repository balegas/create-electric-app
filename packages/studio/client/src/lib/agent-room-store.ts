const STORAGE_KEY = "electric-agent:rooms"
const LEGACY_AGENT_ROOMS_KEY = "electric-agent:agent-rooms"
const LEGACY_SHARED_SESSIONS_KEY = "electric-agent:joined-shared-sessions"

export interface AgentRoomEntry {
	id: string
	code: string
	name: string
	createdAt: string
}

/** One-time migration: merge legacy stores into the unified key. */
function migrateLegacyStores(): void {
	if (localStorage.getItem(STORAGE_KEY)) return // already migrated

	const entries: AgentRoomEntry[] = []
	const seen = new Set<string>()

	// Migrate legacy agent rooms
	try {
		const raw = localStorage.getItem(LEGACY_AGENT_ROOMS_KEY)
		if (raw) {
			for (const r of JSON.parse(raw) as AgentRoomEntry[]) {
				if (!seen.has(r.id)) {
					seen.add(r.id)
					entries.push(r)
				}
			}
		}
	} catch {
		// ignore
	}

	// Migrate legacy shared sessions
	try {
		const raw = localStorage.getItem(LEGACY_SHARED_SESSIONS_KEY)
		if (raw) {
			for (const s of JSON.parse(raw) as Array<{ id: string; code: string; name: string }>) {
				if (!seen.has(s.id)) {
					seen.add(s.id)
					entries.push({ ...s, createdAt: new Date().toISOString() })
				}
			}
		}
	} catch {
		// ignore
	}

	if (entries.length > 0) {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
	}
}

export function getAgentRooms(): AgentRoomEntry[] {
	migrateLegacyStores()
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
