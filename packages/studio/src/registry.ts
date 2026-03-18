import { DurableStream } from "@durable-streams/client"
import type { SessionInfo } from "./sessions.js"
import { getRegistryConnectionInfo, type StreamConfig } from "./streams.js"

// --- Session Registry Event Types (internal to studio) ---

type SessionRegistryEvent =
	| { type: "session_registered"; session: SessionInfo; ts: string }
	| { type: "session_updated"; sessionId: string; update: Partial<SessionInfo>; ts: string }
	| { type: "session_deleted"; sessionId: string; ts: string }
	| { type: "session_mapped"; transcriptPath: string; sessionId: string; ts: string }

/**
 * In-memory session registry backed by a Durable Streams log.
 *
 * On startup, replays the registry stream to hydrate Maps.
 * On mutations, appends to stream then updates in-memory state.
 */
export class SessionRegistry {
	private sessions = new Map<string, SessionInfo>()
	private transcriptToSession = new Map<string, string>()
	private stream: DurableStream

	private constructor(stream: DurableStream) {
		this.stream = stream
	}

	/**
	 * Create and hydrate a SessionRegistry from the durable stream.
	 * Creates the stream if it doesn't exist yet.
	 */
	static async create(config: StreamConfig): Promise<SessionRegistry> {
		const conn = getRegistryConnectionInfo(config)

		// Ensure the stream exists
		try {
			await DurableStream.create({
				url: conn.url,
				headers: conn.headers,
				contentType: "application/json",
			})
		} catch {
			// Stream may already exist — that's fine
		}

		const stream = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})

		const registry = new SessionRegistry(stream)
		await registry.hydrate()
		return registry
	}

	/** Replay the stream to rebuild in-memory state. */
	private async hydrate(): Promise<void> {
		const response = await this.stream.stream<SessionRegistryEvent>({
			offset: "-1",
			live: false,
		})

		await new Promise<void>((resolve) => {
			const cancel = response.subscribeJson<SessionRegistryEvent>((batch) => {
				for (const event of batch.items) {
					this.applyEvent(event)
				}
			})

			// For non-live streams, the subscription ends when all data is consumed.
			// Use a short delay to ensure all batches are processed.
			setTimeout(() => {
				cancel()
				resolve()
			}, 500)
		})

		console.log(`[session-registry] Hydrated: ${this.sessions.size} session(s)`)
	}

	/** Apply a single event to in-memory state (no stream write). */
	private applyEvent(event: SessionRegistryEvent): void {
		switch (event.type) {
			case "session_registered":
				this.sessions.set(event.session.id, event.session)
				break
			case "session_updated": {
				const session = this.sessions.get(event.sessionId)
				if (session) {
					Object.assign(session, event.update)
				}
				break
			}
			case "session_deleted":
				this.sessions.delete(event.sessionId)
				break
			case "session_mapped":
				this.transcriptToSession.set(event.transcriptPath, event.sessionId)
				break
		}
	}

	/** Append an event to the stream and apply it in-memory. */
	private async append(event: SessionRegistryEvent): Promise<void> {
		await this.stream.append(JSON.stringify(event))
		this.applyEvent(event)
	}

	// --- Session CRUD ---

	async addSession(session: SessionInfo): Promise<void> {
		await this.append({
			type: "session_registered",
			session,
			ts: new Date().toISOString(),
		})
	}

	async updateSession(id: string, update: Partial<SessionInfo>): Promise<void> {
		const merged = { ...update, lastActiveAt: new Date().toISOString() }
		await this.append({
			type: "session_updated",
			sessionId: id,
			update: merged,
			ts: new Date().toISOString(),
		})
	}

	async deleteSession(id: string): Promise<boolean> {
		if (!this.sessions.has(id)) return false
		await this.append({
			type: "session_deleted",
			sessionId: id,
			ts: new Date().toISOString(),
		})
		return true
	}

	getSession(id: string): SessionInfo | undefined {
		return this.sessions.get(id)
	}

	listSessions(): SessionInfo[] {
		return Array.from(this.sessions.values())
	}

	/**
	 * Mark stale running sessions as "error".
	 * Returns the number of sessions cleaned up.
	 */
	cleanupStaleSessions(thresholdMs = 2 * 60 * 60 * 1000): number {
		const now = Date.now()
		let count = 0

		for (const session of this.sessions.values()) {
			if (session.status !== "running") continue
			const lastActive = new Date(session.lastActiveAt).getTime()
			if (now - lastActive > thresholdMs) {
				session.status = "error"
				count++
			}
		}

		// Note: stale cleanup is best-effort and does not persist to stream
		// (avoids async in a sync hot path). The status will be corrected on
		// next real mutation or server restart.
		return count
	}

	// --- Transcript → Session Mapping ---

	/**
	 * Look up the EA session ID for a Claude Code transcript path.
	 * Returns undefined if no mapping exists or the session has been deleted.
	 */
	getSessionByTranscript(transcriptPath: string): string | undefined {
		const sessionId = this.transcriptToSession.get(transcriptPath)
		if (!sessionId) return undefined
		// Only return if the session still exists
		return this.sessions.has(sessionId) ? sessionId : undefined
	}

	/**
	 * Durably map a transcript path to an EA session ID.
	 */
	async mapTranscriptToSession(transcriptPath: string, sessionId: string): Promise<void> {
		await this.append({
			type: "session_mapped",
			transcriptPath,
			sessionId,
			ts: new Date().toISOString(),
		})
	}
}
