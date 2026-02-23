import { getApiKey, getGhToken, getOauthToken } from "./credentials"

const API_BASE = "/api"

/** Return user-provided credentials (if set) for inclusion in request bodies. */
function credentialFields(): { apiKey?: string; oauthToken?: string; ghToken?: string } {
	const fields: { apiKey?: string; oauthToken?: string; ghToken?: string } = {}
	const apiKey = getApiKey()
	const oauthToken = getOauthToken()
	const ghToken = getGhToken()
	if (apiKey) fields.apiKey = apiKey
	else if (oauthToken) fields.oauthToken = oauthToken
	if (ghToken) fields.ghToken = ghToken
	return fields
}

/** Return headers with the GH token for GET requests to GitHub routes. */
function ghHeaders(): Record<string, string> {
	const token = getGhToken()
	return token ? { "X-GH-Token": token } : {}
}

async function request<T>(
	path: string,
	opts?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<T> {
	const headers: Record<string, string> = { ...opts?.headers }
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

export function listSessions() {
	return request<{ sessions: SessionInfo[] }>("/sessions")
}

export function getSession(id: string) {
	return request<SessionInfo>(`/sessions/${id}`)
}

export function createSession(description: string, name?: string) {
	return request<{ sessionId: string; streamUrl: string; appPort?: number }>("/sessions", {
		method: "POST",
		body: { description, name, ...credentialFields() },
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
	return request<{ running: boolean; port?: number }>(`/sessions/${sessionId}/app-status`)
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
	return request<{ sessionId: string; streamUrl: string; hasPlan: boolean }>("/sessions/resume", {
		method: "POST",
		body: { repoUrl, branch, ...credentialFields() },
	})
}
