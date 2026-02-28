import type { SessionInfo } from "./api"

const STORAGE_KEY = "electric-agent:sessions"

/**
 * Client-side session store backed by localStorage.
 *
 * Sessions are private to each user/browser. They are only visible
 * to others when explicitly added to a shared room.
 */

export function getSessions(): SessionInfo[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY)
		if (!raw) return []
		return JSON.parse(raw) as SessionInfo[]
	} catch {
		return []
	}
}

export function addSession(session: SessionInfo): void {
	const sessions = getSessions()
	// Deduplicate by id
	const filtered = sessions.filter((s) => s.id !== session.id)
	filtered.push(session)
	localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered))
}

export function updateSession(id: string, update: Partial<SessionInfo>): void {
	const sessions = getSessions()
	const session = sessions.find((s) => s.id === id)
	if (session) {
		Object.assign(session, update, {
			lastActiveAt: new Date().toISOString(),
		})
		localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
	}
}

export function removeSession(id: string): void {
	const sessions = getSessions()
	const filtered = sessions.filter((s) => s.id !== id)
	localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered))
}

export function getSessionById(id: string): SessionInfo | undefined {
	return getSessions().find((s) => s.id === id)
}
