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
import { deriveRoomToken } from "../src/session-auth.js"
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
		devMode: true,
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
// Room Creation Flow Tests
// ---------------------------------------------------------------------------

describe("room creation flow", () => {
	before(async () => {
		await server.start()
		dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "room-flow-test-"))
		sessions = new ActiveSessions()
		rooms = await RoomRegistry.create(server.config)
	})

	after(async () => {
		await server.stop()
		fs.rmSync(dataDir, { recursive: true, force: true })
	})

	describe("POST /api/rooms", () => {
		it("creates a room and returns roomId, code, and roomToken", async () => {
			const app = createTestApp()
			const res = await appFetch(app, "/api/rooms", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Test Room" }),
			})
			assert.equal(res.status, 201)
			const body = (await res.json()) as {
				roomId: string
				code: string
				roomToken: string
			}
			assert.ok(body.roomId, "Should return roomId")
			assert.ok(body.code, "Should return invite code")
			assert.ok(body.roomToken, "Should return roomToken")
			assert.equal(body.roomToken.length, 64)
		})

		it("rejects request without name", async () => {
			const app = createTestApp()
			const res = await appFetch(app, "/api/rooms", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			})
			assert.equal(res.status, 400)
		})

		it("persists room to registry", async () => {
			const app = createTestApp()
			const res = await appFetch(app, "/api/rooms", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Persisted Room" }),
			})
			const { roomId } = (await res.json()) as { roomId: string }

			const room = rooms.getRoom(roomId)
			assert.ok(room, "Room should be in registry")
			assert.equal(room.name, "Persisted Room")
			assert.equal(room.revoked, false)
		})
	})

	describe("GET /api/rooms/:id", () => {
		it("returns room state for an active room", async () => {
			const app = createTestApp()

			// Create room
			const createRes = await appFetch(app, "/api/rooms", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "State Room" }),
			})
			const { roomId, roomToken } = (await createRes.json()) as {
				roomId: string
				roomToken: string
			}

			// Get state
			const stateRes = await appFetch(app, `/api/rooms/${roomId}`, {
				headers: { "X-Room-Token": roomToken },
			})
			assert.equal(stateRes.status, 200)

			const state = (await stateRes.json()) as {
				roomId: string
				state: string
				roundCount: number
				participants: unknown[]
			}
			assert.equal(state.roomId, roomId)
			assert.equal(state.state, "active")
			assert.equal(state.roundCount, 0)
			assert.deepEqual(state.participants, [])
		})

		it("returns 401 without room token", async () => {
			const app = createTestApp()

			const createRes = await appFetch(app, "/api/rooms", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "No Auth Room" }),
			})
			const { roomId } = (await createRes.json()) as { roomId: string }

			const stateRes = await appFetch(app, `/api/rooms/${roomId}`)
			assert.equal(stateRes.status, 401)
		})

		it("returns 401 with wrong room token", async () => {
			const app = createTestApp()

			const createRes = await appFetch(app, "/api/rooms", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Wrong Token Room" }),
			})
			const { roomId } = (await createRes.json()) as { roomId: string }

			const stateRes = await appFetch(app, `/api/rooms/${roomId}`, {
				headers: { "X-Room-Token": "a".repeat(64) },
			})
			assert.equal(stateRes.status, 401)
		})

		it("returns 404 for non-existent room without active router", async () => {
			const app = createTestApp()
			const fakeId = "00000000-0000-0000-0000-000000000000"
			const fakeToken = deriveRoomToken(server.config.secret, fakeId)

			const stateRes = await appFetch(app, `/api/rooms/${fakeId}`, {
				headers: { "X-Room-Token": fakeToken },
			})
			assert.equal(stateRes.status, 404)
		})
	})

	describe("GET /api/join-room/:id/:code", () => {
		it("returns room info with valid code", async () => {
			const app = createTestApp()

			const createRes = await appFetch(app, "/api/rooms", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Joinable Room" }),
			})
			const { roomId, code } = (await createRes.json()) as {
				roomId: string
				code: string
			}

			const joinRes = await appFetch(app, `/api/join-room/${roomId}/${code}`)
			assert.equal(joinRes.status, 200)

			const body = (await joinRes.json()) as {
				id: string
				code: string
				name: string
				roomToken: string
			}
			assert.equal(body.id, roomId)
			assert.equal(body.code, code)
			assert.equal(body.name, "Joinable Room")
			assert.ok(body.roomToken, "Should return roomToken")
		})

		it("returns 404 with wrong code", async () => {
			const app = createTestApp()

			const createRes = await appFetch(app, "/api/rooms", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Secret Room" }),
			})
			const { roomId } = (await createRes.json()) as { roomId: string }

			const joinRes = await appFetch(app, `/api/join-room/${roomId}/WRONG-CODE`)
			assert.equal(joinRes.status, 404)
		})
	})

	describe("POST /api/rooms/:id/agents", () => {
		it("adds an agent and returns session info", async () => {
			const app = createTestApp()

			// Create room
			const createRes = await appFetch(app, "/api/rooms", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Agent Room" }),
			})
			const { roomId, roomToken } = (await createRes.json()) as {
				roomId: string
				roomToken: string
			}

			// Add agent
			const agentRes = await appFetch(app, `/api/rooms/${roomId}/agents`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Room-Token": roomToken,
				},
				body: JSON.stringify({ name: "test-coder", role: "coder" }),
			})
			assert.equal(agentRes.status, 201)

			const body = (await agentRes.json()) as {
				sessionId: string
				participantName: string
				sessionToken: string
			}
			assert.ok(body.sessionId, "Should return sessionId")
			assert.equal(body.participantName, "test-coder")
			assert.ok(body.sessionToken, "Should return sessionToken")
			assert.equal(body.sessionToken.length, 64)
		})

		it("generates a name when none provided", async () => {
			const app = createTestApp()

			const createRes = await appFetch(app, "/api/rooms", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "No Name Room" }),
			})
			const { roomId, roomToken } = (await createRes.json()) as {
				roomId: string
				roomToken: string
			}

			const agentRes = await appFetch(app, `/api/rooms/${roomId}/agents`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Room-Token": roomToken,
				},
				body: JSON.stringify({}),
			})
			assert.equal(agentRes.status, 201)

			const body = (await agentRes.json()) as { participantName: string }
			assert.ok(body.participantName.startsWith("agent-"), "Should auto-generate name")
		})

		it("registers session in ActiveSessions", async () => {
			const app = createTestApp()

			const createRes = await appFetch(app, "/api/rooms", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Session Track Room" }),
			})
			const { roomId, roomToken } = (await createRes.json()) as {
				roomId: string
				roomToken: string
			}

			const agentRes = await appFetch(app, `/api/rooms/${roomId}/agents`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Room-Token": roomToken,
				},
				body: JSON.stringify({ name: "tracker", role: "reviewer" }),
			})
			const { sessionId } = (await agentRes.json()) as { sessionId: string }

			const session = sessions.get(sessionId)
			assert.ok(session, "Session should be tracked in ActiveSessions")
			assert.equal(session.status, "running")
			assert.ok(session.description.includes("tracker"))
		})

		it("returns 401 without room token", async () => {
			const app = createTestApp()

			const createRes = await appFetch(app, "/api/rooms", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Auth Test Room" }),
			})
			const { roomId } = (await createRes.json()) as { roomId: string }

			const agentRes = await appFetch(app, `/api/rooms/${roomId}/agents`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "intruder" }),
			})
			assert.equal(agentRes.status, 401)
		})

		it("returns 404 for non-existent room", async () => {
			const app = createTestApp()
			const fakeId = "00000000-0000-0000-0000-000000000001"
			const fakeToken = deriveRoomToken(server.config.secret, fakeId)

			const agentRes = await appFetch(app, `/api/rooms/${fakeId}/agents`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Room-Token": fakeToken,
				},
				body: JSON.stringify({ name: "ghost" }),
			})
			assert.equal(agentRes.status, 404)
		})
	})

	describe("POST /api/rooms/create-app", () => {
		it("creates room with coder and reviewer sessions", async () => {
			const app = createTestApp()

			const res = await appFetch(app, "/api/rooms/create-app", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ description: "Build a todo app" }),
			})
			assert.equal(res.status, 201)

			const body = (await res.json()) as {
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
			}

			assert.ok(body.roomId, "Should return roomId")
			assert.ok(body.code, "Should return invite code")
			assert.ok(body.name, "Should return room name")
			assert.ok(body.roomToken, "Should return roomToken")

			// Should have exactly 2 sessions: coder + reviewer
			assert.equal(body.sessions.length, 2)

			const coder = body.sessions.find((s) => s.role === "coder")
			const reviewer = body.sessions.find((s) => s.role === "reviewer")
			assert.ok(coder, "Should have coder session")
			assert.ok(reviewer, "Should have reviewer session")
			assert.ok(coder.name.startsWith("coder-"), "Coder name should have coder- prefix")
			assert.ok(
				reviewer.name.startsWith("reviewer-"),
				"Reviewer name should have reviewer- prefix",
			)
			assert.ok(coder.sessionToken, "Coder should have sessionToken")
			assert.ok(reviewer.sessionToken, "Reviewer should have sessionToken")
		})

		it("persists room and sessions to registries", async () => {
			const app = createTestApp()

			const res = await appFetch(app, "/api/rooms/create-app", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ description: "Build a chat app" }),
			})
			const body = (await res.json()) as {
				roomId: string
				sessions: Array<{ sessionId: string; role: string }>
			}

			// Room should be in registry
			const room = rooms.getRoom(body.roomId)
			assert.ok(room, "Room should be persisted in RoomRegistry")

			// All sessions should be in ActiveSessions
			for (const s of body.sessions) {
				const session = sessions.get(s.sessionId)
				assert.ok(session, `Session ${s.role} should be in ActiveSessions`)
				assert.equal(session.status, "running")
			}
		})

		it("rejects request without description", async () => {
			const app = createTestApp()
			const res = await appFetch(app, "/api/rooms/create-app", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			})
			assert.equal(res.status, 400)
		})

		it("uses custom name when provided", async () => {
			const app = createTestApp()

			const res = await appFetch(app, "/api/rooms/create-app", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					description: "Build something",
					name: "my-custom-app",
				}),
			})
			assert.equal(res.status, 201)
			const body = (await res.json()) as { name: string }
			assert.equal(body.name, "my-custom-app")
		})

		it("room state shows pending sessions before sandbox is ready", async () => {
			const app = createTestApp()

			const createRes = await appFetch(app, "/api/rooms/create-app", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ description: "Build a task tracker" }),
			})
			const { roomId, roomToken } = (await createRes.json()) as {
				roomId: string
				roomToken: string
			}

			// Immediately check room state — agents haven't joined as participants yet
			// (sandbox creation is async), but the router should exist
			const stateRes = await appFetch(app, `/api/rooms/${roomId}`, {
				headers: { "X-Room-Token": roomToken },
			})
			assert.equal(stateRes.status, 200)

			const state = (await stateRes.json()) as {
				state: string
				pendingInfraGate: unknown
			}
			assert.equal(state.state, "active")
			// The infra gate should be pending since no one has resolved it
			assert.ok(state.pendingInfraGate, "Should have pending infra gate")
		})
	})

	describe("POST /api/rooms/:id/messages", () => {
		it("sends a message to the room", async () => {
			const app = createTestApp()

			const createRes = await appFetch(app, "/api/rooms", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Message Room" }),
			})
			const { roomId, roomToken } = (await createRes.json()) as {
				roomId: string
				roomToken: string
			}

			const msgRes = await appFetch(app, `/api/rooms/${roomId}/messages`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Room-Token": roomToken,
				},
				body: JSON.stringify({
					from: "human",
					body: "Hello agents!",
				}),
			})
			assert.equal(msgRes.status, 200)

			const body = (await msgRes.json()) as { ok: boolean }
			assert.equal(body.ok, true)
		})

		it("returns 401 without room token", async () => {
			const app = createTestApp()

			const createRes = await appFetch(app, "/api/rooms", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "No Auth Msg Room" }),
			})
			const { roomId } = (await createRes.json()) as { roomId: string }

			const msgRes = await appFetch(app, `/api/rooms/${roomId}/messages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ from: "human", body: "Hello" }),
			})
			assert.equal(msgRes.status, 401)
		})
	})

	describe("POST /api/rooms/:id/close", () => {
		it("closes a room", async () => {
			const app = createTestApp()

			const createRes = await appFetch(app, "/api/rooms", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Closeable Room" }),
			})
			const { roomId, roomToken } = (await createRes.json()) as {
				roomId: string
				roomToken: string
			}

			const closeRes = await appFetch(app, `/api/rooms/${roomId}/close`, {
				method: "POST",
				headers: { "X-Room-Token": roomToken },
			})
			assert.equal(closeRes.status, 200)

			const body = (await closeRes.json()) as { ok: boolean }
			assert.equal(body.ok, true)

			// Room state should now be closed
			const stateRes = await appFetch(app, `/api/rooms/${roomId}`, {
				headers: { "X-Room-Token": roomToken },
			})
			assert.equal(stateRes.status, 200)

			const state = (await stateRes.json()) as { state: string }
			assert.equal(state.state, "closed")
		})

		it("returns 404 for non-existent room", async () => {
			const app = createTestApp()
			const fakeId = "00000000-0000-0000-0000-000000000002"
			const fakeToken = deriveRoomToken(server.config.secret, fakeId)

			const closeRes = await appFetch(app, `/api/rooms/${fakeId}/close`, {
				method: "POST",
				headers: { "X-Room-Token": fakeToken },
			})
			assert.equal(closeRes.status, 404)
		})
	})

	describe("cross-room token isolation", () => {
		it("token from room A is rejected on room B", async () => {
			const app = createTestApp()

			// Create room A
			const resA = await appFetch(app, "/api/rooms", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Room A" }),
			})
			const { roomToken: tokenA } = (await resA.json()) as { roomToken: string }

			// Create room B
			const resB = await appFetch(app, "/api/rooms", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Room B" }),
			})
			const { roomId: roomIdB } = (await resB.json()) as { roomId: string }

			// Use token A on room B
			const stateRes = await appFetch(app, `/api/rooms/${roomIdB}`, {
				headers: { "X-Room-Token": tokenA },
			})
			assert.equal(stateRes.status, 401)
		})
	})
})
