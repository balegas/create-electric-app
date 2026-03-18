import type { SessionRegistry } from "./registry.js"
import type { SessionInfo } from "./sessions.js"

/**
 * In-memory session store with optional durable backing via Registry.
 *
 * When a Registry is provided, mutations are persisted to the durable stream
 * (fire-and-forget — the in-memory state is the source of truth for reads).
 * On startup, call `ActiveSessions.create(registry)` to hydrate from the stream.
 */
export class ActiveSessions {
	private sessions = new Map<string, SessionInfo>()
	private transcriptToSession = new Map<string, string>()
	private registry: SessionRegistry | null = null

	/**
	 * Create an ActiveSessions store backed by a SessionRegistry.
	 * Seeds in-memory state from the registry's persisted sessions.
	 */
	static fromRegistry(registry: SessionRegistry): ActiveSessions {
		const store = new ActiveSessions()
		store.registry = registry

		// Seed from persisted sessions
		for (const session of registry.listSessions()) {
			store.sessions.set(session.id, session)
		}

		console.log(`[active-sessions] Seeded ${store.sessions.size} session(s) from registry`)
		return store
	}

	add(session: SessionInfo): void {
		this.sessions.set(session.id, session)
		this.registry?.addSession(session).catch((err) => {
			console.error(`[active-sessions] Failed to persist add:`, err)
		})
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
			this.registry?.updateSession(id, update).catch((err) => {
				console.error(`[active-sessions] Failed to persist update:`, err)
			})
		}
	}

	delete(id: string): boolean {
		const deleted = this.sessions.delete(id)
		if (deleted) {
			this.registry?.deleteSession(id).catch((err) => {
				console.error(`[active-sessions] Failed to persist delete:`, err)
			})
		}
		return deleted
	}

	/** Check if a session exists in the active store. */
	has(id: string): boolean {
		return this.sessions.has(id)
	}

	/** Return the number of active sessions. */
	size(): number {
		return this.sessions.size
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
		this.registry?.mapTranscriptToSession(transcriptPath, sessionId).catch((err) => {
			console.error(`[active-sessions] Failed to persist transcript mapping:`, err)
		})
	}
}
