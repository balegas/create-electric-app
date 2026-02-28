import type { SessionInfo } from "./sessions.js"

/**
 * Lightweight in-memory session store for the current server lifetime.
 *
 * Sessions are private to each user (stored in their browser's localStorage).
 * The server only tracks active sessions for sandbox/bridge management.
 * This store is NOT persisted — it resets on server restart.
 */
export class ActiveSessions {
	private sessions = new Map<string, SessionInfo>()
	private transcriptToSession = new Map<string, string>()

	add(session: SessionInfo): void {
		this.sessions.set(session.id, session)
	}

	get(id: string): SessionInfo | undefined {
		return this.sessions.get(id)
	}

	update(id: string, update: Partial<SessionInfo>): void {
		const session = this.sessions.get(id)
		if (session) {
			Object.assign(session, update, {
				lastActiveAt: new Date().toISOString(),
			})
		}
	}

	delete(id: string): boolean {
		return this.sessions.delete(id)
	}

	/** Check if a session exists in the active store. */
	has(id: string): boolean {
		return this.sessions.has(id)
	}

	// --- Transcript → Session Mapping (for Claude Code hook integration) ---

	/**
	 * Look up the EA session ID for a Claude Code transcript path.
	 * Returns undefined if no mapping exists or the session has been deleted.
	 */
	getByTranscript(transcriptPath: string): string | undefined {
		const sessionId = this.transcriptToSession.get(transcriptPath)
		if (!sessionId) return undefined
		return this.sessions.has(sessionId) ? sessionId : undefined
	}

	/**
	 * Map a transcript path to an EA session ID.
	 */
	mapTranscript(transcriptPath: string, sessionId: string): void {
		this.transcriptToSession.set(transcriptPath, sessionId)
	}
}
