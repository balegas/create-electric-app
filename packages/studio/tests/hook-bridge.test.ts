import "dotenv/config"
import "./setup-proxy.js"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { DurableStream } from "@durable-streams/client"
import { ActiveSessions } from "../src/active-sessions.js"
import { RoomRegistry } from "../src/room-registry.js"
import type { SandboxHandle, SandboxProvider } from "../src/sandbox/types.js"
import { createApp } from "../src/server.js"
import { cleanupStaleSessions, getSession, readSessionIndex } from "../src/sessions.js"
import { localStreamServer } from "./local-stream-server.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const server = localStreamServer()

/** Temp data dir for session index files */
let dataDir: string

/** Shared session tracking — recreated per test suite */
let sessions: ActiveSessions
let rooms: RoomRegistry

/** Create a mock SandboxProvider that throws on unexpected calls */
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

/** Create a Hono app with test config */
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

/** Make a fetch-compatible request to the Hono app */
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
// Tests
// ---------------------------------------------------------------------------

describe("hook-bridge integration", () => {
	before(async () => {
		await server.start()
		dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-bridge-test-"))
		sessions = new ActiveSessions()
		rooms = await RoomRegistry.create(server.config)
	})

	after(async () => {
		await server.stop()
		fs.rmSync(dataDir, { recursive: true, force: true })
	})

	it("POST /api/sessions/auto with SessionStart creates a session", async () => {
		const app = createTestApp()

		const res = await appFetch(app, "/api/sessions/auto", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				hook_event_name: "SessionStart",
				session_id: "claude-123",
				cwd: "/Users/test/my-project",
			}),
		})

		assert.equal(res.status, 201)
		const body = (await res.json()) as { sessionId: string }
		assert.ok(body.sessionId, "Should return a sessionId")

		// Verify session was created in the active sessions store
		const session = sessions.get(body.sessionId)
		assert.ok(session, "Session should exist in active sessions")
		assert.equal(session.projectName, "my-project")
		assert.equal(session.status, "running")
	})

	it("POST /api/sessions/auto rejects non-SessionStart events", async () => {
		const app = createTestApp()

		const res = await appFetch(app, "/api/sessions/auto", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_use_id: "tu_123",
				tool_input: { command: "ls" },
			}),
		})

		assert.equal(res.status, 400)
		const body = (await res.json()) as { error: string }
		assert.ok(body.error.includes("SessionStart"))
	})

	it("hook-event forwarding: events appear in the stream", async () => {
		const app = createTestApp()

		// 1. Auto-register a session
		const autoRes = await appFetch(app, "/api/sessions/auto", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				hook_event_name: "SessionStart",
				session_id: "claude-456",
				cwd: "/Users/test/forwarding-test",
			}),
		})
		const { sessionId, hookToken } = (await autoRes.json()) as { sessionId: string; hookToken: string }

		// 2. Forward a PreToolUse event (with hook token)
		const hookRes = await appFetch(app, `/api/sessions/${sessionId}/hook-event`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${hookToken}`,
			},
			body: JSON.stringify({
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_use_id: "tu_789",
				tool_input: { command: "npm test" },
			}),
		})
		assert.equal(hookRes.status, 200)

		// 3. Read the stream and verify events
		const conn = server.connection(sessionId)
		const reader = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})
		const response = await reader.stream<Record<string, unknown>>({
			offset: "-1",
			live: false,
		})
		const items = await response.json()

		// Should have session_start (from auto) + pre_tool_use (from hook-event)
		assert.ok(items.length >= 2, `Expected at least 2 events, got ${items.length}`)

		const types = items.map((i) => (i as Record<string, unknown>).type)
		assert.ok(types.includes("session_start"), "Should have session_start event")
		assert.ok(types.includes("pre_tool_use"), "Should have pre_tool_use event")
	})

	it("SessionEnd marks session as complete and cleans up bridge", async () => {
		const app = createTestApp()

		// 1. Auto-register
		const autoRes = await appFetch(app, "/api/sessions/auto", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				hook_event_name: "SessionStart",
				session_id: "claude-end-test",
				cwd: "/Users/test/end-test",
			}),
		})
		const { sessionId, hookToken } = (await autoRes.json()) as { sessionId: string; hookToken: string }

		// 2. Send SessionEnd (with hook token)
		const endRes = await appFetch(app, `/api/sessions/${sessionId}/hook-event`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${hookToken}`,
			},
			body: JSON.stringify({
				hook_event_name: "SessionEnd",
			}),
		})
		assert.equal(endRes.status, 200)

		// 3. Verify session status is "complete"
		const session = sessions.get(sessionId)
		assert.ok(session, "Session should still exist")
		assert.equal(session.status, "complete")
	})

	it("cleanupStaleSessions marks old running sessions as error", () => {
		// Manually write a session with an old lastActiveAt
		const staleId = "stale-session-test"
		const index = readSessionIndex(dataDir)
		index.sessions.push({
			id: staleId,
			projectName: "stale-project",
			sandboxProjectDir: "",
			description: "Stale test",
			createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3h ago
			lastActiveAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3h ago
			status: "running",
		})
		fs.writeFileSync(path.join(dataDir, "sessions.json"), JSON.stringify(index, null, 2), "utf-8")

		// Run cleanup with 2h threshold (default)
		const cleaned = cleanupStaleSessions(dataDir)
		assert.ok(cleaned >= 1, `Expected at least 1 cleaned session, got ${cleaned}`)

		// Verify the stale session is now "error"
		const session = getSession(dataDir, staleId)
		assert.ok(session, "Stale session should still exist")
		assert.equal(session.status, "error")
	})
})
