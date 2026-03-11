import "dotenv/config"
import "./setup-proxy.js"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { ActiveSessions } from "../src/active-sessions.js"
import { RoomRegistry } from "../src/room-registry.js"
import type { SandboxHandle, SandboxProvider } from "../src/sandbox/types.js"
import { createApp } from "../src/server.js"
import { deriveSessionToken, validateSessionToken } from "../src/session-auth.js"
import { localStreamServer } from "./local-stream-server.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const server = localStreamServer()

let dataDir: string
let sessions: ActiveSessions
let rooms: RoomRegistry

function mockSandboxProvider(): SandboxProvider {
	return {
		runtime: "docker" as const,
		async create() {
			throw new Error("Unexpected sandbox create call")
		},
		async destroy() {
			throw new Error("Unexpected sandbox destroy call")
		},
		async restartAgent() {
			throw new Error("Unexpected sandbox restartAgent call")
		},
		get() {
			return undefined
		},
		list() {
			return []
		},
		isAlive() {
			return false
		},
		async listFiles() {
			return []
		},
		async readFile() {
			return null
		},
		async startApp() {
			return false
		},
		async stopApp() {
			return false
		},
		async isAppRunning() {
			return false
		},
		async exec() {
			return ""
		},
		async gitStatus() {
			return {
				initialized: false,
				branch: null,
				hasUncommitted: false,
				lastCommitHash: null,
				lastCommitMessage: null,
			}
		},
		async createFromRepo(): Promise<SandboxHandle> {
			throw new Error("Unexpected sandbox createFromRepo call")
		},
	}
}

function createTestApp() {
	return createApp({
		port: 0,
		dataDir,
		sessions,
		rooms,
		sandbox: mockSandboxProvider(),
		streamConfig: server.config,
		bridgeMode: "stream",
	})
}

async function appFetch(
	app: ReturnType<typeof createApp>,
	path: string,
	init?: RequestInit,
): Promise<Response> {
	const url = `http://localhost${path}`
	const req = new Request(url, init)
	return app.fetch(req)
}

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

describe("session-auth unit", () => {
	const secret = "test-secret-key"

	it("deriveSessionToken returns 64-char hex string", () => {
		const token = deriveSessionToken(secret, "session-1")
		assert.equal(token.length, 64)
		assert.match(token, /^[0-9a-f]{64}$/)
	})

	it("deriveSessionToken is deterministic", () => {
		const t1 = deriveSessionToken(secret, "session-1")
		const t2 = deriveSessionToken(secret, "session-1")
		assert.equal(t1, t2)
	})

	it("different session IDs produce different tokens", () => {
		const t1 = deriveSessionToken(secret, "session-1")
		const t2 = deriveSessionToken(secret, "session-2")
		assert.notEqual(t1, t2)
	})

	it("validateSessionToken returns true for valid token", () => {
		const token = deriveSessionToken(secret, "session-1")
		assert.equal(validateSessionToken(secret, "session-1", token), true)
	})

	it("validateSessionToken returns false for wrong token", () => {
		assert.equal(validateSessionToken(secret, "session-1", "a".repeat(64)), false)
	})

	it("validateSessionToken returns false for wrong session ID", () => {
		const token = deriveSessionToken(secret, "session-1")
		assert.equal(validateSessionToken(secret, "session-2", token), false)
	})

	it("validateSessionToken returns false for empty string", () => {
		assert.equal(validateSessionToken(secret, "session-1", ""), false)
	})
})

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe("session-auth integration", () => {
	before(async () => {
		await server.start()
		dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-auth-test-"))
		sessions = new ActiveSessions()
		rooms = await RoomRegistry.create(server.config)
	})

	after(async () => {
		await server.stop()
		fs.rmSync(dataDir, { recursive: true, force: true })
	})

	it("POST /api/sessions/local returns sessionToken", async () => {
		const app = createTestApp()
		const res = await appFetch(app, "/api/sessions/local", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ description: "test" }),
		})
		assert.equal(res.status, 201)
		const body = (await res.json()) as { sessionId: string; sessionToken: string }
		assert.ok(body.sessionToken, "Should return sessionToken")
		assert.equal(body.sessionToken.length, 64)
	})

	it("POST /api/sessions/auto returns sessionToken", async () => {
		const app = createTestApp()
		const res = await appFetch(app, "/api/sessions/auto", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				hook_event_name: "SessionStart",
				session_id: "claude-auth-test",
				cwd: "/tmp/auth-test",
			}),
		})
		assert.equal(res.status, 201)
		const body = (await res.json()) as { sessionId: string; sessionToken: string }
		assert.ok(body.sessionToken, "Should return sessionToken")
	})

	it("GET /api/sessions/:id returns 401 without token", async () => {
		const app = createTestApp()

		// Create a session first
		const createRes = await appFetch(app, "/api/sessions/local", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		})
		const { sessionId } = (await createRes.json()) as { sessionId: string }

		// GET without token
		const res = await appFetch(app, `/api/sessions/${sessionId}`)
		assert.equal(res.status, 401)
	})

	it("GET /api/sessions/:id returns 401 with wrong token", async () => {
		const app = createTestApp()

		const createRes = await appFetch(app, "/api/sessions/local", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		})
		const { sessionId } = (await createRes.json()) as { sessionId: string }

		const res = await appFetch(app, `/api/sessions/${sessionId}`, {
			headers: { Authorization: `Bearer ${"a".repeat(64)}` },
		})
		assert.equal(res.status, 401)
	})

	it("GET /api/sessions/:id returns 200 with valid token", async () => {
		const app = createTestApp()

		const createRes = await appFetch(app, "/api/sessions/local", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		})
		const { sessionId, sessionToken } = (await createRes.json()) as {
			sessionId: string
			sessionToken: string
		}

		const res = await appFetch(app, `/api/sessions/${sessionId}`, {
			headers: { Authorization: `Bearer ${sessionToken}` },
		})
		assert.equal(res.status, 200)
	})

	it("POST /api/sessions/:id/iterate returns 401 without token", async () => {
		const app = createTestApp()

		const createRes = await appFetch(app, "/api/sessions/local", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		})
		const { sessionId } = (await createRes.json()) as { sessionId: string }

		const res = await appFetch(app, `/api/sessions/${sessionId}/iterate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ request: "test" }),
		})
		assert.equal(res.status, 401)
	})

	it("POST /api/sessions/:id/hook-event requires hook token", async () => {
		const app = createTestApp()

		const createRes = await appFetch(app, "/api/sessions/local", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		})
		const { sessionId, hookToken } = (await createRes.json()) as {
			sessionId: string
			hookToken: string
		}

		// Without token — should be rejected
		const noTokenRes = await appFetch(app, `/api/sessions/${sessionId}/hook-event`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_use_id: "tu_auth_test",
				tool_input: { command: "ls" },
			}),
		})
		assert.equal(noTokenRes.status, 401)

		// With hook token — should succeed
		const withTokenRes = await appFetch(app, `/api/sessions/${sessionId}/hook-event`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${hookToken}`,
			},
			body: JSON.stringify({
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_use_id: "tu_auth_test_2",
				tool_input: { command: "ls" },
			}),
		})
		assert.equal(withTokenRes.status, 200)
	})

	it("token for session A is rejected on session B", async () => {
		const app = createTestApp()

		// Create session A
		const resA = await appFetch(app, "/api/sessions/local", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		})
		const { sessionToken: tokenA } = (await resA.json()) as {
			sessionId: string
			sessionToken: string
		}

		// Create session B
		const resB = await appFetch(app, "/api/sessions/local", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		})
		const { sessionId: sessionIdB } = (await resB.json()) as {
			sessionId: string
			sessionToken: string
		}

		// Use token A on session B
		const res = await appFetch(app, `/api/sessions/${sessionIdB}`, {
			headers: { Authorization: `Bearer ${tokenA}` },
		})
		assert.equal(res.status, 401)
	})

	it("GET /api/sessions/:id/events?token=... accepts query param token", async () => {
		const app = createTestApp()

		const createRes = await appFetch(app, "/api/sessions/local", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		})
		const { sessionId, sessionToken } = (await createRes.json()) as {
			sessionId: string
			sessionToken: string
		}

		// SSE endpoint with token as query param — should not return 401
		const controller = new AbortController()
		const res = await appFetch(app, `/api/sessions/${sessionId}/events?token=${sessionToken}`, {
			signal: controller.signal,
		})
		// SSE returns 200 with text/event-stream
		assert.notEqual(res.status, 401, "Should not reject valid query param token")
		// Abort the streaming connection so the test can exit cleanly
		controller.abort()
	})

	it("DELETE /api/sessions/:id requires valid token", async () => {
		const app = createTestApp()

		const createRes = await appFetch(app, "/api/sessions/local", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		})
		const { sessionId } = (await createRes.json()) as { sessionId: string }

		// DELETE without token
		const res = await appFetch(app, `/api/sessions/${sessionId}`, {
			method: "DELETE",
		})
		assert.equal(res.status, 401)
	})
})

// ---------------------------------------------------------------------------
// Room Token Auth Integration Tests
// ---------------------------------------------------------------------------

describe.skip("room-auth integration (legacy shared-session routes removed)", () => {
	before(async () => {
		await server.start()
		dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "room-auth-test-"))
		sessions = new ActiveSessions()
		rooms = await RoomRegistry.create(server.config)
	})

	after(async () => {
		await server.stop()
		fs.rmSync(dataDir, { recursive: true, force: true })
	})

	const participant = { id: "test-user", displayName: "Test User" }

	it("POST /api/shared-sessions returns roomToken", async () => {
		const app = createTestApp()
		const res = await appFetch(app, "/api/shared-sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Test Room", participant }),
		})
		assert.equal(res.status, 201)
		const body = (await res.json()) as { id: string; code: string; roomToken: string }
		assert.ok(body.roomToken, "Should return roomToken")
		assert.equal(body.roomToken.length, 64)
	})

	it("GET /api/shared-sessions/join/:id/:code returns roomToken", async () => {
		const app = createTestApp()

		// Create a room first
		const createRes = await appFetch(app, "/api/shared-sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Join Test", participant }),
		})
		const { id, code } = (await createRes.json()) as { id: string; code: string; roomToken: string }

		// Join by id + code
		const joinRes = await appFetch(app, `/api/shared-sessions/join/${id}/${code}`)
		assert.equal(joinRes.status, 200)
		const body = (await joinRes.json()) as { id: string; roomToken: string }
		assert.ok(body.roomToken, "Should return roomToken on join")
		assert.equal(body.roomToken.length, 64)
	})

	it("POST /api/shared-sessions/:id/join returns 401 without token", async () => {
		const app = createTestApp()

		const createRes = await appFetch(app, "/api/shared-sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Auth Test", participant }),
		})
		const { id } = (await createRes.json()) as { id: string }

		// Try to join without token
		const res = await appFetch(app, `/api/shared-sessions/${id}/join`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ participant: { id: "other", displayName: "Other" } }),
		})
		assert.equal(res.status, 401)
	})

	it("POST /api/shared-sessions/:id/join returns 200 with valid token", async () => {
		const app = createTestApp()

		const createRes = await appFetch(app, "/api/shared-sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Auth OK Test", participant }),
		})
		const { id, roomToken } = (await createRes.json()) as {
			id: string
			roomToken: string
		}

		const res = await appFetch(app, `/api/shared-sessions/${id}/join`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${roomToken}`,
			},
			body: JSON.stringify({ participant: { id: "other", displayName: "Other" } }),
		})
		assert.equal(res.status, 200)
	})

	it("room token from room A is rejected on room B", async () => {
		const app = createTestApp()

		// Create room A
		const resA = await appFetch(app, "/api/shared-sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Room A", participant }),
		})
		const { roomToken: tokenA } = (await resA.json()) as { roomToken: string }

		// Create room B
		const resB = await appFetch(app, "/api/shared-sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Room B", participant }),
		})
		const { id: idB } = (await resB.json()) as { id: string }

		// Use token A on room B
		const res = await appFetch(app, `/api/shared-sessions/${idB}/join`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${tokenA}`,
			},
			body: JSON.stringify({ participant: { id: "intruder", displayName: "Intruder" } }),
		})
		assert.equal(res.status, 401)
	})

	it("GET /api/shared-sessions/:id/events?token=... accepts query param token", async () => {
		const app = createTestApp()

		const createRes = await appFetch(app, "/api/shared-sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "SSE Test", participant }),
		})
		const { id, roomToken } = (await createRes.json()) as {
			id: string
			roomToken: string
		}

		const controller = new AbortController()
		const res = await appFetch(app, `/api/shared-sessions/${id}/events?token=${roomToken}`, {
			signal: controller.signal,
		})
		assert.notEqual(res.status, 401, "Should not reject valid query param token")
		controller.abort()
	})

	it("GET /api/shared-sessions/:id/events returns 401 without token", async () => {
		const app = createTestApp()

		const createRes = await appFetch(app, "/api/shared-sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "SSE No Auth", participant }),
		})
		const { id } = (await createRes.json()) as { id: string }

		const controller = new AbortController()
		const res = await appFetch(app, `/api/shared-sessions/${id}/events`, {
			signal: controller.signal,
		})
		assert.equal(res.status, 401)
		controller.abort()
	})

	it("POST /api/shared-sessions/:id/revoke returns 401 without token", async () => {
		const app = createTestApp()

		const createRes = await appFetch(app, "/api/shared-sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Revoke Auth Test", participant }),
		})
		const { id } = (await createRes.json()) as { id: string }

		const res = await appFetch(app, `/api/shared-sessions/${id}/revoke`, {
			method: "POST",
		})
		assert.equal(res.status, 401)
	})
})
