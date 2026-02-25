import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export interface SharedSessionEntry {
	id: string
	/** 8-char random invite code (e.g. "ABCD-1234") */
	code: string
	createdAt: string
	revoked: boolean
}

interface SharedSessionIndex {
	sharedSessions: SharedSessionEntry[]
}

function indexPath(dataDir: string): string {
	return path.join(dataDir, "shared-sessions.json")
}

function readIndex(dataDir: string): SharedSessionIndex {
	const file = indexPath(dataDir)
	if (!fs.existsSync(file)) {
		return { sharedSessions: [] }
	}
	return JSON.parse(fs.readFileSync(file, "utf-8")) as SharedSessionIndex
}

function writeIndex(dataDir: string, index: SharedSessionIndex): void {
	fs.mkdirSync(dataDir, { recursive: true })
	fs.writeFileSync(indexPath(dataDir), JSON.stringify(index, null, 2), "utf-8")
}

/**
 * Generate a cryptographically random 8-char invite code (e.g. "ABCD-1234").
 */
export function generateInviteCode(): string {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // No ambiguous chars (0/O, 1/I)
	const bytes = crypto.randomBytes(8)
	let code = ""
	for (let i = 0; i < 8; i++) {
		code += chars[bytes[i] % chars.length]
	}
	return `${code.slice(0, 4)}-${code.slice(4)}`
}

export function addSharedSession(dataDir: string, entry: SharedSessionEntry): void {
	const index = readIndex(dataDir)
	index.sharedSessions.push(entry)
	writeIndex(dataDir, index)
}

export function getSharedSessionByCode(
	dataDir: string,
	code: string,
): SharedSessionEntry | undefined {
	const index = readIndex(dataDir)
	return index.sharedSessions.find((s) => s.code === code)
}

export function getSharedSession(dataDir: string, id: string): SharedSessionEntry | undefined {
	const index = readIndex(dataDir)
	return index.sharedSessions.find((s) => s.id === id)
}

export function revokeSharedSession(dataDir: string, id: string): boolean {
	const index = readIndex(dataDir)
	const entry = index.sharedSessions.find((s) => s.id === id)
	if (!entry) return false
	entry.revoked = true
	writeIndex(dataDir, index)
	return true
}
