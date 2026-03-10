import { getApiKey, getGhToken, getOauthToken } from "./credentials"
import { getOrCreateParticipant } from "./participant"
import { getRoomToken, getSessionToken, setRoomToken, setSessionToken } from "./session-store"

const API_BASE = "/api"

/** Return user-provided credentials (if set) for inclusion in request bodies. */
function credentialFields(): { apiKey?: string; oauthToken?: string; ghToken?: string } {
	const fields: { apiKey?: string; oauthToken?: string; ghToken?: string } = {}
	const apiKey = getApiKey()
	const oauthToken = getOauthToken()
	const ghToken = getGhToken()
	if (oauthToken) fields.oauthToken = oauthToken
	else if (apiKey) fields.apiKey = apiKey
	if (ghToken) fields.ghToken = ghToken
	return fields
}

/** Return headers with the GH token for GET requests to GitHub routes. */
function ghHeaders(): Record<string, string> {
	const token = getGhToken()
	return token ? { "X-GH-Token": token } : {}
}

/** Return participant identity headers for gate attribution. */
function participantHeaders(): Record<string, string> {
	const p = getOrCreateParticipant()
	return { "X-Participant-Id": p.id, "X-Participant-Name": p.displayName }
}

/** Extract session ID from API paths like /sessions/:id or /sessions/:id/... */
function extractSessionId(path: string): string | undefined {
	const match = path.match(/^\/sessions\/([^/]+)/)
	return match?.[1]
}

/** Extract shared session ID from API paths like /shared-sessions/:id/... */
function extractSharedSessionId(path: string): string | undefined {
	const match = path.match(/^\/shared-sessions\/([^/]+)/)
	if (!match) return undefined
	// Don't match the "join" path (it's the code-lookup route, not a room ID)
	if (match[1] === "join") return undefined
	return match[1]
}

async function request<T>(
	path: string,
	opts?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<T> {
	const headers: Record<string, string> = { ...participantHeaders(), ...opts?.headers }
	if (opts?.body) headers["Content-Type"] = "application/json"

	// Attach session token for session-scoped requests
	const sessionId = extractSessionId(path)
	if (sessionId) {
		const token = getSessionToken(sessionId)
		if (token) {
			headers.Authorization = `Bearer ${token}`
		}
	}

	// Attach room token for shared-session-scoped requests
	const sharedSessionId = extractSharedSessionId(path)
	if (sharedSessionId) {
		const token = getRoomToken(sharedSessionId)
		if (token) {
			headers.Authorization = `Bearer ${token}`
		}
	}

	const res = await fetch(`${API_BASE}${path}`, {
		method: opts?.method ?? "GET",
		headers: Object.keys(headers).length > 0 ? headers : undefined,
		body: opts?.body ? JSON.stringify(opts.body) : undefined,
	})

	if (!res.ok) {
		const error = await res.json().catch(() => ({ error: res.statusText }))
		throw new Error((error as { error: string }).error || res.statusText)
	}

	return res.json() as Promise<T>
}

export interface SessionGitState {
	branch: string
	remoteUrl: string | null
	repoName: string | null
	lastCommitHash: string | null
	lastCommitMessage: string | null
	lastCheckpointAt: string | null
}

export interface SessionInfo {
	id: string
	projectName: string
	sandboxProjectDir: string
	description: string
	createdAt: string
	lastActiveAt: string
	status: "running" | "complete" | "error" | "cancelled"
	appPort?: number
	previewUrl?: string
	totalCostUsd?: number
	totalTurns?: number
	totalDurationMs?: number
	git?: SessionGitState
}

export interface GitStatus {
	initialized: boolean
	branch: string | null
	remoteUrl: string | null
	hasUncommitted: boolean
	lastCommit: { hash: string; message: string; ts: string } | null
	repoName: string | null
}

export interface GhRepo {
	nameWithOwner: string
	url: string
	updatedAt: string
}

export interface GhBranch {
	name: string
	isDefault: boolean
}

// --- Session CRUD ---

export function getSession(id: string) {
	return request<SessionInfo>(`/sessions/${id}`)
}

/** Create a local session for Claude Code hook forwarding (no sandbox). */
export async function createLocalSession(description?: string) {
	const result = await request<{ sessionId: string; sessionToken: string }>("/sessions/local", {
		method: "POST",
		body: { description },
	})
	if (result.sessionToken) {
		setSessionToken(result.sessionId, result.sessionToken)
	}
	return result
}

export async function createSession(description: string, name?: string, freeform?: boolean) {
	const result = await request<{ sessionId: string; session: SessionInfo; sessionToken: string }>(
		"/sessions",
		{
			method: "POST",
			body: { description, name, freeform, ...credentialFields() },
		},
	)
	if (result.sessionToken) {
		setSessionToken(result.sessionId, result.sessionToken)
	}
	return result
}

export function sendIterate(sessionId: string, userRequest: string) {
	return request<{ ok: boolean }>(`/sessions/${sessionId}/iterate`, {
		method: "POST",
		body: { request: userRequest },
	})
}

export function respondToGate(sessionId: string, gate: string, data: Record<string, unknown>) {
	return request<{ ok: boolean }>(`/sessions/${sessionId}/respond`, {
		method: "POST",
		body: { gate, ...data },
	})
}

export function interruptSession(sessionId: string) {
	return request<{ ok: boolean }>(`/sessions/${sessionId}/interrupt`, {
		method: "POST",
	})
}

export function cancelSession(sessionId: string) {
	return request<{ ok: boolean }>(`/sessions/${sessionId}/cancel`, {
		method: "POST",
	})
}

export function deleteSession(sessionId: string) {
	return request<{ ok: boolean }>(`/sessions/${sessionId}`, {
		method: "DELETE",
	})
}

// --- App status ---

export function startApp(sessionId: string) {
	return request<{ ok: boolean }>(`/sessions/${sessionId}/start-app`, {
		method: "POST",
	})
}

export function stopApp(sessionId: string) {
	return request<{ success: boolean; output: string }>(`/sessions/${sessionId}/stop-app`, {
		method: "POST",
	})
}

// --- Electric Claim API ---

export interface ProvisionResult {
	sourceId: string
	secret: string
	databaseUrl: string
	electricUrl: string
	claimId: string
	claimUrl: string
}

export function provisionElectric() {
	return request<ProvisionResult>("/provision-electric", { method: "POST" })
}

// --- Git/GitHub ---

export function getGitStatus(sessionId: string) {
	return request<GitStatus>(`/sessions/${sessionId}/git-status`)
}

export function listGithubRepos() {
	return request<{ repos: GhRepo[] }>("/github/repos", { headers: ghHeaders() })
}

export function listBranches(repoFullName: string) {
	return request<{ branches: GhBranch[] }>(`/github/repos/${repoFullName}/branches`, {
		headers: ghHeaders(),
	})
}

export function fetchKeychainCredentials() {
	return request<{ oauthToken: string | null }>("/credentials/keychain")
}

export async function resumeFromGithub(repoUrl: string, branch?: string) {
	const result = await request<{
		sessionId: string
		session: SessionInfo
		sessionToken: string
	}>("/sessions/resume", {
		method: "POST",
		body: { repoUrl, branch, ...credentialFields() },
	})
	if (result.sessionToken) {
		setSessionToken(result.sessionId, result.sessionToken)
	}
	return result
}

// --- Shared Sessions (Rooms) ---

export async function createSharedSession(name: string) {
	const participant = getOrCreateParticipant()
	const result = await request<{ id: string; code: string; roomToken: string }>(
		"/shared-sessions",
		{
			method: "POST",
			body: { name, participant },
		},
	)
	if (result.roomToken) {
		setRoomToken(result.id, result.roomToken)
	}
	return result
}

export async function joinSharedSession(id: string, code: string) {
	const result = await request<{ id: string; code: string; revoked: boolean; roomToken: string }>(
		`/shared-sessions/join/${id}/${code}`,
	)
	if (result.roomToken) {
		setRoomToken(result.id, result.roomToken)
	}
	return result
}

export function joinAsParticipant(sharedSessionId: string) {
	const participant = getOrCreateParticipant()
	return request<{ ok: boolean }>(`/shared-sessions/${sharedSessionId}/join`, {
		method: "POST",
		body: { participant },
	})
}

export function leaveSharedSession(sharedSessionId: string) {
	const participant = getOrCreateParticipant()
	return request<{ ok: boolean }>(`/shared-sessions/${sharedSessionId}/leave`, {
		method: "POST",
		body: { participantId: participant.id },
	})
}

export function pingRoom(sharedSessionId: string) {
	const participant = getOrCreateParticipant()
	return request<{ ok: boolean }>(`/shared-sessions/${sharedSessionId}/ping`, {
		method: "POST",
		body: { participantId: participant.id, displayName: participant.displayName },
	})
}

export function getRoomPresence(sharedSessionId: string) {
	return request<{ participants: { id: string; displayName: string }[] }>(
		`/shared-sessions/${sharedSessionId}/presence`,
	)
}

export function linkSession(
	sharedSessionId: string,
	sessionId: string,
	sessionName: string,
	sessionDescription: string,
) {
	const participant = getOrCreateParticipant()
	return request<{ ok: boolean }>(`/shared-sessions/${sharedSessionId}/sessions`, {
		method: "POST",
		body: {
			sessionId,
			sessionName,
			sessionDescription,
			linkedBy: participant.displayName,
		},
	})
}

export function unlinkSession(sharedSessionId: string, sessionId: string) {
	return request<{ ok: boolean }>(`/shared-sessions/${sharedSessionId}/sessions/${sessionId}`, {
		method: "DELETE",
	})
}

export function getLinkedSessionToken(roomId: string, sessionId: string) {
	return request<{ sessionToken: string }>(`/shared-sessions/${roomId}/sessions/${sessionId}/token`)
}

export function revokeSharedSession(sharedSessionId: string) {
	return request<{ ok: boolean }>(`/shared-sessions/${sharedSessionId}/revoke`, {
		method: "POST",
	})
}

// --- Agent Rooms ---

export interface RoomState {
	roomId: string
	state: "active" | "closed"
	roundCount: number
	participants: Array<{ sessionId: string; name: string; role?: string }>
}

export async function createAgentRoom(name: string, maxRounds?: number) {
	return request<{ roomId: string; code: string; roomToken: string }>("/rooms", {
		method: "POST",
		body: { name, maxRounds },
	})
}

export async function joinAgentRoom(id: string, code: string) {
	return request<{ id: string; code: string; name: string; roomToken: string }>(
		`/rooms/join/${id}/${code}`,
	)
}

export function getAgentRoomState(roomId: string) {
	return request<RoomState>(`/rooms/${roomId}`)
}

export function addAgentToRoom(
	roomId: string,
	config: {
		name: string
		role?: string
		gated?: boolean
		initialPrompt?: string
	},
) {
	return request<{ sessionId: string; participantName: string; sessionToken: string }>(
		`/rooms/${roomId}/agents`,
		{
			method: "POST",
			body: { ...config, ...credentialFields() },
		},
	)
}

export function addSessionToRoom(
	roomId: string,
	config: {
		sessionId: string
		name: string
		role?: string
		gated?: boolean
		initialPrompt?: string
	},
) {
	// Must prove ownership of the session being added
	const token = getSessionToken(config.sessionId)
	return request<{ sessionId: string; participantName: string }>(
		`/rooms/${roomId}/sessions`,
		{
			method: "POST",
			body: config,
			headers: token ? { Authorization: `Bearer ${token}` } : undefined,
		},
	)
}

export function sendRoomMessage(roomId: string, from: string, body: string, to?: string) {
	return request<{ ok: boolean }>(`/rooms/${roomId}/messages`, {
		method: "POST",
		body: { from, body, ...(to ? { to } : {}) },
	})
}

export function iterateRoomSession(roomId: string, sessionId: string, userRequest: string) {
	return request<{ ok: boolean }>(`/rooms/${roomId}/sessions/${sessionId}/iterate`, {
		method: "POST",
		body: { request: userRequest },
	})
}

export function closeAgentRoom(roomId: string) {
	return request<{ ok: boolean }>(`/rooms/${roomId}/close`, {
		method: "POST",
	})
}
