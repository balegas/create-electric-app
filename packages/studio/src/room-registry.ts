import { DurableStream } from "@durable-streams/client"
import { getRegistryConnectionInfo, type StreamConfig } from "./streams.js"

export interface RoomInfo {
	id: string
	/** 8-char random invite code (e.g. "ABCD-1234") */
	code: string
	name: string
	createdAt: string
	revoked: boolean
}

// --- Room Registry Events (persisted to Durable Streams) ---

type RoomRegistryEvent =
	| { type: "room_created"; room: RoomInfo; ts: string }
	| { type: "room_revoked"; roomId: string; ts: string }

/**
 * Durable Streams-backed room registry.
 *
 * On startup, replays the registry stream to hydrate in-memory Maps.
 * On mutations, appends to stream then updates in-memory state.
 *
 * This only tracks room metadata (not sessions — those are private
 * to each user's browser localStorage).
 */
export class RoomRegistry {
	private rooms = new Map<string, RoomInfo>()
	private roomsByCode = new Map<string, RoomInfo>()
	private stream: DurableStream

	private constructor(stream: DurableStream) {
		this.stream = stream
	}

	/**
	 * Create and hydrate a RoomRegistry from the durable stream.
	 * Creates the stream if it doesn't exist yet.
	 */
	static async create(config: StreamConfig): Promise<RoomRegistry> {
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

		const registry = new RoomRegistry(stream)
		await registry.hydrate()
		return registry
	}

	/** Replay the stream to rebuild in-memory state. */
	private async hydrate(): Promise<void> {
		const response = await this.stream.stream<RoomRegistryEvent>({
			offset: "-1",
			live: false,
		})

		await new Promise<void>((resolve) => {
			const cancel = response.subscribeJson<RoomRegistryEvent>((batch) => {
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

		console.log(`[room-registry] Hydrated: ${this.rooms.size} room(s)`)
	}

	/** Apply a single event to in-memory state (no stream write). */
	private applyEvent(event: RoomRegistryEvent): void {
		switch (event.type) {
			case "room_created":
				this.rooms.set(event.room.id, event.room)
				this.roomsByCode.set(event.room.code, event.room)
				break
			case "room_revoked": {
				const room = this.rooms.get(event.roomId)
				if (room) {
					room.revoked = true
				}
				break
			}
		}
	}

	/** Append an event to the stream and apply it in-memory. */
	private async append(event: RoomRegistryEvent): Promise<void> {
		await this.stream.append(JSON.stringify(event))
		this.applyEvent(event)
	}

	// --- Room CRUD ---

	async addRoom(room: RoomInfo): Promise<void> {
		await this.append({
			type: "room_created",
			room,
			ts: new Date().toISOString(),
		})
	}

	getRoom(id: string): RoomInfo | undefined {
		return this.rooms.get(id)
	}

	getRoomByCode(code: string): RoomInfo | undefined {
		return this.roomsByCode.get(code)
	}

	async revokeRoom(id: string): Promise<boolean> {
		if (!this.rooms.has(id)) return false
		await this.append({
			type: "room_revoked",
			roomId: id,
			ts: new Date().toISOString(),
		})
		return true
	}
}
