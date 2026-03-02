import { getAgentMode, getApiKey, getGhToken, getOauthToken } from "./credentials"
import { getOrCreateParticipant } from "./participant"

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

async function request<T>(
	path: string,
	opts?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<T> {
	const headers: Record<string, string> = { ...participantHeaders(), ...opts?.headers }
	if (opts?.body) headers["Content-Type"] = "application/json"

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
export function createLocalSession(description?: string) {
	return request<{ sessionId: string }>("/sessions/local", {
		method: "POST",
		body: { description },
	})
}

export function createSession(description: string, name?: string) {
	return request<{ sessionId: string; session: SessionInfo }>("/sessions", {
		method: "POST",
		body: { description, name, agentMode: getAgentMode(), ...credentialFields() },
	})
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

export function getAppStatus(sessionId: string) {
	return request<{ running: boolean; port?: number; previewUrl?: string }>(
		`/sessions/${sessionId}/app-status`,
	)
}

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

export function resumeFromGithub(repoUrl: string, branch?: string) {
	return request<{ sessionId: string; session: SessionInfo }>("/sessions/resume", {
		method: "POST",
		body: { repoUrl, branch, ...credentialFields() },
	})
}

// --- Shared Sessions (Rooms) ---

export function createSharedSession(name: string) {
	const participant = getOrCreateParticipant()
	return request<{ id: string; code: string }>("/shared-sessions", {
		method: "POST",
		body: { name, participant },
	})
}

export function joinSharedSession(code: string) {
	return request<{ id: string; code: string; revoked: boolean }>(`/shared-sessions/join/${code}`)
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

export function revokeSharedSession(sharedSessionId: string) {
	return request<{ ok: boolean }>(`/shared-sessions/${sharedSessionId}/revoke`, {
		method: "POST",
	})
}
