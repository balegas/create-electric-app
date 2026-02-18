import fs from "node:fs"
import path from "node:path"

export interface SessionInfo {
	id: string
	projectName: string
	projectDir: string
	description: string
	createdAt: string
	lastActiveAt: string
	status: "running" | "complete" | "error" | "cancelled"
	/** SDK session ID from the last coder run — used to resume conversation context across iterations */
	lastCoderSessionId?: string
}

interface SessionIndex {
	sessions: SessionInfo[]
}

function indexPath(dataDir: string): string {
	return path.join(dataDir, "sessions.json")
}

export function readSessionIndex(dataDir: string): SessionIndex {
	const file = indexPath(dataDir)
	if (!fs.existsSync(file)) {
		return { sessions: [] }
	}
	return JSON.parse(fs.readFileSync(file, "utf-8")) as SessionIndex
}

function writeSessionIndex(dataDir: string, index: SessionIndex): void {
	fs.mkdirSync(dataDir, { recursive: true })
	fs.writeFileSync(indexPath(dataDir), JSON.stringify(index, null, 2), "utf-8")
}

export function addSession(dataDir: string, session: SessionInfo): void {
	const index = readSessionIndex(dataDir)
	index.sessions.push(session)
	writeSessionIndex(dataDir, index)
}

export function updateSessionInfo(
	dataDir: string,
	sessionId: string,
	update: Partial<SessionInfo>,
): void {
	const index = readSessionIndex(dataDir)
	const session = index.sessions.find((s) => s.id === sessionId)
	if (session) {
		Object.assign(session, update, { lastActiveAt: new Date().toISOString() })
		writeSessionIndex(dataDir, index)
	}
}

export function getSession(dataDir: string, sessionId: string): SessionInfo | undefined {
	const index = readSessionIndex(dataDir)
	return index.sessions.find((s) => s.id === sessionId)
}
