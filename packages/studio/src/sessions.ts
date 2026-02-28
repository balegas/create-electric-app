import fs from "node:fs"
import path from "node:path"

export interface SessionInfo {
	id: string
	projectName: string
	/** Path inside the sandbox where the project lives */
	sandboxProjectDir: string
	description: string
	createdAt: string
	lastActiveAt: string
	status: "running" | "complete" | "error" | "cancelled"
	/** SDK session ID from the last coder run — used to resume conversation context across iterations */
	lastCoderSessionId?: string
	/** Host port mapped to the sandbox's dev server */
	appPort?: number
	/** Preview URL for cloud sandboxes (Daytona) */
	previewUrl?: string
	/** Claim ID from the Electric Claim API — used for "claim into your account" */
	claimId?: string
	/** Claude Code's own session ID — maps Claude sessions to EA sessions */
	claudeSessionId?: string
	/** Agent mode used to create this session */
	agentMode?: "electric-agent" | "claude-code"
	/** Git state — populated after scaffold or publish */
	git?: {
		branch: string
		remoteUrl: string | null
		repoName: string | null
		repoVisibility?: "public" | "private"
		lastCommitHash: string | null
		lastCommitMessage: string | null
		lastCheckpointAt: string | null
	}
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

export function deleteSession(dataDir: string, sessionId: string): boolean {
	const index = readSessionIndex(dataDir)
	const before = index.sessions.length
	index.sessions = index.sessions.filter((s) => s.id !== sessionId)
	if (index.sessions.length === before) return false
	writeSessionIndex(dataDir, index)
	return true
}

export function getSession(dataDir: string, sessionId: string): SessionInfo | undefined {
	const index = readSessionIndex(dataDir)
	return index.sessions.find((s) => s.id === sessionId)
}

/**
 * Mark stale running sessions as "error".
 * A session is stale if its status is "running" and lastActiveAt is older than thresholdMs.
 * Returns the number of sessions cleaned up.
 */
export function cleanupStaleSessions(dataDir: string, thresholdMs = 2 * 60 * 60 * 1000): number {
	const index = readSessionIndex(dataDir)
	const now = Date.now()
	let count = 0

	for (const session of index.sessions) {
		if (session.status !== "running") continue
		const lastActive = new Date(session.lastActiveAt).getTime()
		if (now - lastActive > thresholdMs) {
			session.status = "error"
			count++
		}
	}

	if (count > 0) {
		writeSessionIndex(dataDir, index)
	}
	return count
}
