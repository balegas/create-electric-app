import type { EngineEvent, RoomEvent } from "./events.js"

// ---------------------------------------------------------------------------
// Config & Types
// ---------------------------------------------------------------------------

export interface TokenStore {
	getSessionToken: (id: string) => string | undefined
	setSessionToken: (id: string, token: string) => void
	getRoomToken: (id: string) => string | undefined
	setRoomToken: (id: string, token: string) => void
}

export interface ClientConfig {
	/** Base URL for the API, e.g. "http://localhost:4400/api" */
	baseUrl: string
	/** Return user credentials to include in request bodies */
	credentials?: () => {
		apiKey?: string
		oauthToken?: string
		ghToken?: string
	}
	/** Return participant identity for gate attribution headers */
	participant?: () => { id: string; displayName: string }
	/** Pluggable token storage (defaults to in-memory Map) */
	tokenStore?: TokenStore
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
	needsInput?: boolean
	appPort?: number
	previewUrl?: string
	totalCostUsd?: number
	totalTurns?: number
	totalDurationMs?: number
	git?: SessionGitState
}

export interface StudioConfig {
	devMode: boolean
	maxSessionCostUsd?: number
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

export interface ProvisionResult {
	sourceId: string
	secret: string
	databaseUrl: string
	electricUrl: string
	claimId: string
	claimUrl: string
}

export interface RoomState {
	roomId: string
	state: "active" | "closed" | "interrupted"
	roundCount: number
	previewUrl?: string
	appPort?: number
	pendingInfraGate?: {
		sessionId: string
		projectName: string
		runtime: string
	}
	resolvedInfraDetails?: Record<string, string>
	participants: Array<{
		sessionId: string
		name: string
		role?: string
		running?: boolean
		needsInput?: boolean
	}>
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

/** Default reconnection parameters */
const SSE_INITIAL_RETRY_MS = 1000
const SSE_MAX_RETRY_MS = 30_000
const SSE_BACKOFF_FACTOR = 2

interface SSEEvent {
	id?: string
	data: string
}

/**
 * Parse a raw SSE text chunk and yield complete events.
 *
 * Maintains internal state across chunks via the returned generator — callers
 * feed successive text chunks and receive fully-assembled events as they
 * become available.
 */
function createSSEParser(): {
	feed: (chunk: string) => SSEEvent[]
} {
	let buffer = ""
	let currentId: string | undefined
	let currentData: string[] = []

	return {
		feed(chunk: string): SSEEvent[] {
			buffer += chunk
			const events: SSEEvent[] = []
			const lines = buffer.split("\n")
			// Keep the last (potentially incomplete) line in the buffer
			buffer = lines.pop() ?? ""

			for (const line of lines) {
				if (line === "") {
					// Empty line = event boundary
					if (currentData.length > 0) {
						events.push({
							id: currentId,
							data: currentData.join("\n"),
						})
					}
					currentId = undefined
					currentData = []
				} else if (line.startsWith("data:")) {
					currentData.push(line.slice(5).trimStart())
				} else if (line.startsWith("id:")) {
					currentId = line.slice(3).trimStart()
				}
				// "retry:" is noted but we handle reconnection ourselves
			}

			return events
		},
	}
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ElectricAgentClient {
	private readonly baseUrl: string
	private readonly credentials: ClientConfig["credentials"]
	private readonly participant: ClientConfig["participant"]
	private readonly tokens: TokenStore

	constructor(config: ClientConfig) {
		// Strip trailing slash
		this.baseUrl = config.baseUrl.replace(/\/+$/, "")
		this.credentials = config.credentials
		this.participant = config.participant
		this.tokens = config.tokenStore ?? createInMemoryTokenStore()
	}

	// -----------------------------------------------------------------------
	// Internal HTTP helper
	// -----------------------------------------------------------------------

	private async request<T>(
		path: string,
		opts?: {
			method?: string
			body?: unknown
			headers?: Record<string, string>
		},
	): Promise<T> {
		const headers: Record<string, string> = { ...opts?.headers }

		// Participant identity headers
		if (this.participant) {
			const p = this.participant()
			headers["X-Participant-Id"] = p.id
			headers["X-Participant-Name"] = p.displayName
		}

		if (opts?.body) {
			headers["Content-Type"] = "application/json"
		}

		// Attach session token for session-scoped requests
		const sessionId = extractSessionId(path)
		if (sessionId) {
			const token = this.tokens.getSessionToken(sessionId)
			if (token) {
				headers.Authorization = `Bearer ${token}`
			}
		}

		// Attach room token for room-scoped requests
		const roomId = extractRoomId(path)
		if (roomId) {
			const token = this.tokens.getRoomToken(roomId)
			if (token) {
				headers["X-Room-Token"] = token
			}
		}

		const res = await fetch(`${this.baseUrl}${path}`, {
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

	/** Return credential fields to merge into POST bodies. */
	private credentialFields(): {
		apiKey?: string
		oauthToken?: string
		ghToken?: string
	} {
		return this.credentials ? this.credentials() : {}
	}

	// -----------------------------------------------------------------------
	// Config
	// -----------------------------------------------------------------------

	getConfig(): Promise<StudioConfig> {
		return this.request<StudioConfig>("/config")
	}

	/** Fetch OAuth token from macOS Keychain (server-side). Returns null if not available. */
	async fetchKeychainCredentials(): Promise<{ oauthToken: string | null }> {
		return this.request<{ oauthToken: string | null }>("/credentials/keychain")
	}

	// -----------------------------------------------------------------------
	// Session CRUD
	// -----------------------------------------------------------------------

	getSession(id: string): Promise<SessionInfo> {
		return this.request<SessionInfo>(`/sessions/${id}`)
	}

	async createSession(
		description: string,
		name?: string,
		freeform?: boolean,
	): Promise<{
		sessionId: string
		session: SessionInfo
		sessionToken: string
	}> {
		const result = await this.request<{
			sessionId: string
			session: SessionInfo
			sessionToken: string
		}>("/sessions", {
			method: "POST",
			body: { description, name, freeform, ...this.credentialFields() },
		})
		if (result.sessionToken) {
			this.tokens.setSessionToken(result.sessionId, result.sessionToken)
		}
		return result
	}

	async createLocalSession(
		description?: string,
	): Promise<{ sessionId: string; sessionToken: string }> {
		const result = await this.request<{
			sessionId: string
			sessionToken: string
		}>("/sessions/local", {
			method: "POST",
			body: { description },
		})
		if (result.sessionToken) {
			this.tokens.setSessionToken(result.sessionId, result.sessionToken)
		}
		return result
	}

	sendIterate(sessionId: string, userRequest: string): Promise<{ ok: boolean }> {
		return this.request<{ ok: boolean }>(`/sessions/${sessionId}/iterate`, {
			method: "POST",
			body: { request: userRequest },
		})
	}

	respondToGate(
		sessionId: string,
		gate: string,
		data: Record<string, unknown>,
	): Promise<{ ok: boolean }> {
		return this.request<{ ok: boolean }>(`/sessions/${sessionId}/respond`, {
			method: "POST",
			body: { gate, ...data },
		})
	}

	interruptSession(sessionId: string): Promise<{ ok: boolean }> {
		return this.request<{ ok: boolean }>(`/sessions/${sessionId}/interrupt`, { method: "POST" })
	}

	cancelSession(sessionId: string): Promise<{ ok: boolean }> {
		return this.request<{ ok: boolean }>(`/sessions/${sessionId}/cancel`, { method: "POST" })
	}

	deleteSession(sessionId: string): Promise<{ ok: boolean }> {
		return this.request<{ ok: boolean }>(`/sessions/${sessionId}`, {
			method: "DELETE",
		})
	}

	// -----------------------------------------------------------------------
	// App status
	// -----------------------------------------------------------------------

	startApp(sessionId: string): Promise<{ ok: boolean }> {
		return this.request<{ ok: boolean }>(`/sessions/${sessionId}/start-app`, { method: "POST" })
	}

	stopApp(sessionId: string): Promise<{ success: boolean; output: string }> {
		return this.request<{ success: boolean; output: string }>(`/sessions/${sessionId}/stop-app`, {
			method: "POST",
		})
	}

	// -----------------------------------------------------------------------
	// Rooms
	// -----------------------------------------------------------------------

	async createAppRoom(
		description: string,
		name?: string,
	): Promise<{
		roomId: string
		code: string
		name: string
		roomToken: string
		sessions: Array<{
			sessionId: string
			name: string
			role: string
			sessionToken: string
		}>
	}> {
		const result = await this.request<{
			roomId: string
			code: string
			name: string
			roomToken: string
			sessions: Array<{
				sessionId: string
				name: string
				role: string
				sessionToken: string
			}>
		}>("/rooms/create-app", {
			method: "POST",
			body: { description, name, ...this.credentialFields() },
		})
		if (result.roomToken) {
			this.tokens.setRoomToken(result.roomId, result.roomToken)
		}
		for (const s of result.sessions) {
			if (s.sessionToken) {
				this.tokens.setSessionToken(s.sessionId, s.sessionToken)
			}
		}
		return result
	}

	async createAgentRoom(
		name: string,
		maxRounds?: number,
	): Promise<{ roomId: string; code: string; roomToken: string }> {
		const result = await this.request<{
			roomId: string
			code: string
			roomToken: string
		}>("/rooms", {
			method: "POST",
			body: { name, maxRounds },
		})
		if (result.roomToken) {
			this.tokens.setRoomToken(result.roomId, result.roomToken)
		}
		return result
	}

	async joinAgentRoom(
		id: string,
		code: string,
	): Promise<{ id: string; code: string; name: string; roomToken: string }> {
		const result = await this.request<{
			id: string
			code: string
			name: string
			roomToken: string
		}>(`/join-room/${id}/${code}`)
		if (result.roomToken) {
			this.tokens.setRoomToken(result.id, result.roomToken)
		}
		return result
	}

	getAgentRoomState(roomId: string): Promise<RoomState> {
		return this.request<RoomState>(`/rooms/${roomId}`)
	}

	async addAgentToRoom(
		roomId: string,
		config: {
			name?: string
			role?: string
			initialPrompt?: string
		},
	): Promise<{
		sessionId: string
		participantName: string
		sessionToken: string
	}> {
		const result = await this.request<{
			sessionId: string
			participantName: string
			sessionToken: string
		}>(`/rooms/${roomId}/agents`, {
			method: "POST",
			body: { ...config, ...this.credentialFields() },
		})
		if (result.sessionToken) {
			this.tokens.setSessionToken(result.sessionId, result.sessionToken)
		}
		return result
	}

	sendRoomMessage(
		roomId: string,
		from: string,
		body: string,
		to?: string,
	): Promise<{ ok: boolean }> {
		return this.request<{ ok: boolean }>(`/rooms/${roomId}/messages`, {
			method: "POST",
			body: { from, body, ...(to ? { to } : {}) },
		})
	}

	closeAgentRoom(roomId: string): Promise<{ ok: boolean }> {
		return this.request<{ ok: boolean }>(`/rooms/${roomId}/close`, {
			method: "POST",
		})
	}

	addSessionToRoom(
		roomId: string,
		config: {
			sessionId: string
			name: string
			initialPrompt?: string
		},
	): Promise<{ sessionId: string; participantName: string }> {
		// Must prove ownership of the session being added
		const token = this.tokens.getSessionToken(config.sessionId)
		return this.request<{ sessionId: string; participantName: string }>(
			`/rooms/${roomId}/sessions`,
			{
				method: "POST",
				body: config,
				headers: token ? { Authorization: `Bearer ${token}` } : undefined,
			},
		)
	}

	iterateRoomSession(
		roomId: string,
		sessionId: string,
		userRequest: string,
	): Promise<{ ok: boolean }> {
		return this.request<{ ok: boolean }>(`/rooms/${roomId}/sessions/${sessionId}/iterate`, {
			method: "POST",
			body: { request: userRequest },
		})
	}

	// -----------------------------------------------------------------------
	// GitHub / Git
	// -----------------------------------------------------------------------

	async fetchGhAccounts(): Promise<Array<{ login: string; type: string }>> {
		const creds = this.credentialFields()
		if (!creds.ghToken) return []
		try {
			const res = await fetch(`${this.baseUrl}/github/accounts`, {
				headers: { "X-GH-Token": creds.ghToken },
			})
			if (!res.ok) return []
			const data = (await res.json()) as {
				accounts?: Array<{ login: string; type: string }>
			}
			return data.accounts ?? []
		} catch {
			return []
		}
	}

	getGitStatus(sessionId: string): Promise<GitStatus> {
		return this.request<GitStatus>(`/sessions/${sessionId}/git-status`)
	}

	listGithubRepos(): Promise<{ repos: GhRepo[] }> {
		const creds = this.credentialFields()
		return this.request<{ repos: GhRepo[] }>("/github/repos", {
			headers: creds.ghToken ? { "X-GH-Token": creds.ghToken } : undefined,
		})
	}

	listBranches(repoFullName: string): Promise<{ branches: GhBranch[] }> {
		const creds = this.credentialFields()
		return this.request<{ branches: GhBranch[] }>(`/github/repos/${repoFullName}/branches`, {
			headers: creds.ghToken ? { "X-GH-Token": creds.ghToken } : undefined,
		})
	}

	async resumeFromGithub(
		repoUrl: string,
		branch?: string,
	): Promise<{
		sessionId: string
		session: SessionInfo
		sessionToken: string
	}> {
		const result = await this.request<{
			sessionId: string
			session: SessionInfo
			sessionToken: string
		}>("/sessions/resume", {
			method: "POST",
			body: { repoUrl, branch, ...this.credentialFields() },
		})
		if (result.sessionToken) {
			this.tokens.setSessionToken(result.sessionId, result.sessionToken)
		}
		return result
	}

	// -----------------------------------------------------------------------
	// Electric Provisioning
	// -----------------------------------------------------------------------

	provisionElectric(): Promise<ProvisionResult> {
		return this.request<ProvisionResult>("/provision-electric", {
			method: "POST",
		})
	}

	// -----------------------------------------------------------------------
	// SSE Streams
	// -----------------------------------------------------------------------

	/**
	 * Subscribe to session events as an async iterable.
	 *
	 * Automatically reconnects with exponential backoff when the connection
	 * drops. Pass an AbortSignal to terminate the stream.
	 *
	 * ```ts
	 * const ac = new AbortController()
	 * for await (const event of client.sessionEvents("abc", { signal: ac.signal })) {
	 *   console.log(event)
	 * }
	 * ```
	 */
	sessionEvents(sessionId: string, opts?: { signal?: AbortSignal }): AsyncIterable<EngineEvent> {
		return this.sseStream<EngineEvent>(`/sessions/${sessionId}/events`, opts)
	}

	/**
	 * Subscribe to room events as an async iterable.
	 *
	 * Same reconnection semantics as `sessionEvents`.
	 */
	roomEvents(roomId: string, opts?: { signal?: AbortSignal }): AsyncIterable<RoomEvent> {
		return this.sseStream<RoomEvent>(`/rooms/${roomId}/events`, opts)
	}

	/**
	 * Generic SSE subscription that returns an AsyncIterable.
	 *
	 * - Uses `fetch` (no EventSource dependency — works in Node 18+)
	 * - Reconnects with exponential backoff on network errors
	 * - Tracks the last event `id` so the server can resume from where we
	 *   left off (via the `offset` query parameter)
	 * - The caller can abort by signalling the provided AbortSignal
	 */
	private sseStream<T>(path: string, opts?: { signal?: AbortSignal }): AsyncIterable<T> {
		const client = this
		const externalSignal = opts?.signal

		return {
			[Symbol.asyncIterator](): AsyncIterator<T> {
				// Queue of parsed events waiting to be yielded
				const queue: T[] = []
				// Pending resolve from a consumer awaiting the next value
				let waiting:
					| {
							resolve: (v: IteratorResult<T, undefined>) => void
							reject: (e: unknown) => void
					  }
					| undefined
				let done = false
				let lastEventId: string | undefined
				let retryMs = SSE_INITIAL_RETRY_MS
				let currentAbort: AbortController | undefined

				// Start consuming immediately
				consume()

				function push(value: T) {
					if (done) return
					if (waiting) {
						const w = waiting
						waiting = undefined
						w.resolve({ value, done: false })
					} else {
						queue.push(value)
					}
				}

				function finish(error?: unknown) {
					if (done) return
					done = true
					currentAbort?.abort()
					if (waiting) {
						const w = waiting
						waiting = undefined
						if (error) {
							w.reject(error)
						} else {
							w.resolve({
								value: undefined,
								done: true,
							})
						}
					}
				}

				// Listen for external abort
				if (externalSignal) {
					if (externalSignal.aborted) {
						done = true
					} else {
						externalSignal.addEventListener("abort", () => finish(), { once: true })
					}
				}

				async function consume() {
					while (!done) {
						try {
							currentAbort = new AbortController()

							// Link external signal to internal abort
							if (externalSignal) {
								if (externalSignal.aborted) {
									finish()
									return
								}
								externalSignal.addEventListener("abort", () => currentAbort?.abort(), {
									once: true,
								})
							}

							const url = buildSSEUrl(client.baseUrl, path, lastEventId)
							const headers: Record<string, string> = {
								Accept: "text/event-stream",
							}

							// Auth headers
							if (client.participant) {
								const p = client.participant()
								headers["X-Participant-Id"] = p.id
								headers["X-Participant-Name"] = p.displayName
							}
							const sessionId = extractSessionId(path)
							if (sessionId) {
								const token = client.tokens.getSessionToken(sessionId)
								if (token) {
									headers.Authorization = `Bearer ${token}`
								}
							}
							const roomId = extractRoomId(path)
							if (roomId) {
								const token = client.tokens.getRoomToken(roomId)
								if (token) {
									headers["X-Room-Token"] = token
								}
							}

							const res = await fetch(url, {
								headers,
								signal: currentAbort.signal,
							})

							if (!res.ok) {
								const errBody = await res.text().catch(() => res.statusText)
								throw new Error(`SSE request failed (${res.status}): ${errBody}`)
							}

							if (!res.body) {
								throw new Error("SSE response has no body stream")
							}

							// Reset backoff on successful connect
							retryMs = SSE_INITIAL_RETRY_MS

							const parser = createSSEParser()
							const reader = res.body.getReader()
							const decoder = new TextDecoder()

							// eslint-disable-next-line no-constant-condition
							while (true) {
								const { value, done: streamDone } = await reader.read()
								if (streamDone) break

								const text = decoder.decode(value, {
									stream: true,
								})
								const events = parser.feed(text)

								for (const evt of events) {
									if (evt.id) {
										lastEventId = evt.id
									}
									try {
										const parsed = JSON.parse(evt.data) as T
										push(parsed)
									} catch {
										// Skip malformed JSON
									}
								}
							}

							// Stream ended cleanly — server closed the
							// connection. Reconnect unless we've been
							// cancelled.
						} catch (err: unknown) {
							if (done) return

							// AbortError means we were intentionally
							// cancelled
							if (err instanceof DOMException && err.name === "AbortError") {
								finish()
								return
							}
							if (err instanceof Error && err.name === "AbortError") {
								finish()
								return
							}
						}

						// Reconnect after backoff
						if (done) return
						await delay(retryMs)
						retryMs = Math.min(retryMs * SSE_BACKOFF_FACTOR, SSE_MAX_RETRY_MS)
					}
				}

				return {
					next(): Promise<IteratorResult<T, undefined>> {
						if (queue.length > 0) {
							return Promise.resolve({
								value: queue.shift() as T,
								done: false,
							})
						}
						if (done) {
							return Promise.resolve({
								value: undefined,
								done: true,
							})
						}
						return new Promise<IteratorResult<T, undefined>>((resolve, reject) => {
							waiting = { resolve, reject }
						})
					},

					return(): Promise<IteratorResult<T, undefined>> {
						finish()
						return Promise.resolve({
							value: undefined,
							done: true,
						})
					},

					throw(err: unknown): Promise<IteratorResult<T, undefined>> {
						finish(err)
						return Promise.resolve({
							value: undefined,
							done: true,
						})
					},
				}
			},
		}
	}
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Extract session ID from API paths like /sessions/:id or /sessions/:id/... */
function extractSessionId(path: string): string | undefined {
	const match = path.match(/^\/sessions\/([^/]+)/)
	return match?.[1]
}

/** Extract room ID from API paths like /rooms/:id/... */
function extractRoomId(path: string): string | undefined {
	const match = path.match(/^\/rooms\/([^/]+)/)
	return match?.[1]
}

/** Build the SSE URL, appending an `offset` query param when resuming. */
function buildSSEUrl(baseUrl: string, path: string, lastEventId: string | undefined): string {
	const url = new URL(`${baseUrl}${path}`)
	if (lastEventId) {
		url.searchParams.set("offset", lastEventId)
	}
	return url.toString()
}

/** Promise-based delay. */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Create a simple in-memory token store (default when none is provided). */
function createInMemoryTokenStore(): TokenStore {
	const sessionTokens = new Map<string, string>()
	const roomTokens = new Map<string, string>()
	return {
		getSessionToken: (id) => sessionTokens.get(id),
		setSessionToken: (id, token) => {
			sessionTokens.set(id, token)
		},
		getRoomToken: (id) => roomTokens.get(id),
		setRoomToken: (id, token) => {
			roomTokens.set(id, token)
		},
	}
}
