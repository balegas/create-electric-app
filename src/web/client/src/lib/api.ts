const API_BASE = "/api"

async function request<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
	const res = await fetch(`${API_BASE}${path}`, {
		method: opts?.method ?? "GET",
		headers: opts?.body ? { "Content-Type": "application/json" } : undefined,
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
		body: { description, name },
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

// --- Settings ---

export function getSettings() {
	return request<{ hasApiKey: boolean; hasGhToken: boolean }>("/settings")
}

export function updateSettings(settings: { anthropicApiKey?: string; githubPat?: string }) {
	return request<{ ok: boolean; ghUsername?: string }>("/settings", {
		method: "PUT",
		body: settings,
	})
}

// --- Model Settings ---

export interface ModelInfo {
	id: string
	label: string
	tier: string
}

export interface PlannerModelConfig {
	model: string
	maxThinkingTokens: number
	maxTurns: number
}

export interface CoderModelConfig {
	model: string
	maxThinkingTokens: number
	maxTurns: number
	maxBudgetUsd: number
}

export interface AgentModelSettings {
	planner: PlannerModelConfig
	coder: CoderModelConfig
}

export function getModelSettings() {
	return request<{ models: ModelInfo[]; settings: AgentModelSettings }>("/model-settings")
}

export function updateModelSettings(settings: Partial<AgentModelSettings>) {
	return request<{ ok: boolean; settings: AgentModelSettings }>("/model-settings", {
		method: "PUT",
		body: settings,
	})
}

// --- Git/GitHub ---

export function getGitStatus(sessionId: string) {
	return request<GitStatus>(`/sessions/${sessionId}/git-status`)
}

export function listGithubRepos() {
	return request<{ repos: GhRepo[] }>("/github/repos")
}

export function listBranches(repoFullName: string) {
	return request<{ branches: GhBranch[] }>(`/github/repos/${repoFullName}/branches`)
}

// --- Files ---

export function listFiles(sessionId: string) {
	return request<{ files: string[]; prefix: string }>(`/sessions/${sessionId}/files`)
}

export function readFileContent(sessionId: string, filePath: string) {
	return request<{ content: string }>(
		`/sessions/${sessionId}/file-content?path=${encodeURIComponent(filePath)}`,
	)
}

export function resumeFromGithub(repoUrl: string, branch?: string) {
	return request<{ sessionId: string; streamUrl: string; hasPlan: boolean }>("/sessions/resume", {
		method: "POST",
		body: { repoUrl, branch },
	})
}
