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

export interface SessionInfo {
	id: string
	projectName: string
	projectDir: string
	description: string
	createdAt: string
	lastActiveAt: string
	status: "running" | "complete" | "error" | "cancelled"
}

export function listSessions() {
	return request<{ sessions: SessionInfo[] }>("/sessions")
}

export function getSession(id: string) {
	return request<SessionInfo>(`/sessions/${id}`)
}

export function createSession(description: string, name?: string) {
	return request<{ sessionId: string; streamUrl: string }>("/sessions", {
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
