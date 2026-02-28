const STORAGE_KEY = "electric-agent:joined-shared-sessions"

export interface JoinedSharedSession {
	id: string
	code: string
	name: string
}

export function getJoinedSharedSessions(): JoinedSharedSession[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY)
		if (!raw) return []
		return JSON.parse(raw) as JoinedSharedSession[]
	} catch {
		return []
	}
}

export function addJoinedSharedSession(entry: JoinedSharedSession): void {
	const sessions = getJoinedSharedSessions()
	// Deduplicate by code
	const filtered = sessions.filter((s) => s.code !== entry.code)
	filtered.push(entry)
	localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered))
}

export function removeJoinedSharedSession(code: string): void {
	const sessions = getJoinedSharedSessions()
	const filtered = sessions.filter((s) => s.code !== code)
	localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered))
}
