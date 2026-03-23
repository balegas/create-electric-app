import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname } from "node:path"
import { getConfigPath } from "./config.js"
import type { SessionInfo } from "@electric-agent/protocol/client"

interface StoredSession {
	id: string
	projectName: string
	description: string
	createdAt: string
	lastActiveAt: string
	status: string
	previewUrl?: string
	sessionToken?: string
}

interface StoredRoom {
	id: string
	name: string
	code: string
	createdAt: string
	roomToken?: string
	sessionTokens?: Record<string, string>
}

interface SessionStoreData {
	sessions: StoredSession[]
	rooms: StoredRoom[]
}

function getStorePath(): string {
	const configPath = getConfigPath()
	return configPath.replace(/config\.json$/, "sessions.json")
}

function load(): SessionStoreData {
	try {
		const path = getStorePath()
		if (!existsSync(path)) return { sessions: [], rooms: [] }
		const raw = readFileSync(path, "utf-8")
		const data = JSON.parse(raw) as Partial<SessionStoreData>
		return {
			sessions: data.sessions ?? [],
			rooms: data.rooms ?? [],
		}
	} catch {
		return { sessions: [], rooms: [] }
	}
}

function save(data: SessionStoreData): void {
	const path = getStorePath()
	const dir = dirname(path)
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true })
	}
	writeFileSync(path, JSON.stringify(data, null, "\t") + "\n", "utf-8")
}

export function loadSessions(): StoredSession[] {
	return load().sessions
}

export function saveSession(session: SessionInfo, sessionToken?: string): void {
	const data = load()
	const existing = data.sessions.findIndex((s) => s.id === session.id)
	const entry: StoredSession = {
		id: session.id,
		projectName: session.projectName,
		description: session.description,
		createdAt: session.createdAt,
		lastActiveAt: session.lastActiveAt,
		status: session.status,
		previewUrl: session.previewUrl,
		sessionToken,
	}
	if (existing >= 0) {
		data.sessions[existing] = entry
	} else {
		data.sessions.push(entry)
	}
	save(data)
}

export function updateSessionStatus(sessionId: string, status: string): void {
	const data = load()
	const session = data.sessions.find((s) => s.id === sessionId)
	if (session) {
		session.status = status
		session.lastActiveAt = new Date().toISOString()
		save(data)
	}
}

export function deleteStoredSession(sessionId: string): void {
	const data = load()
	data.sessions = data.sessions.filter((s) => s.id !== sessionId)
	save(data)
}

export function deleteStoredRoom(roomId: string): void {
	const data = load()
	data.rooms = data.rooms.filter((r) => r.id !== roomId)
	save(data)
}

export function loadRooms(): StoredRoom[] {
	return load().rooms
}

export function saveRoom(
	room: { id: string; name: string; code: string },
	roomToken?: string,
	sessionTokens?: Record<string, string>,
): void {
	const data = load()
	const existing = data.rooms.findIndex((r) => r.id === room.id)
	const entry: StoredRoom = {
		id: room.id,
		name: room.name,
		code: room.code,
		createdAt: new Date().toISOString(),
		roomToken,
		sessionTokens,
	}
	if (existing >= 0) {
		data.rooms[existing] = entry
	} else {
		data.rooms.push(entry)
	}
	save(data)
}

export type { StoredSession, StoredRoom }
