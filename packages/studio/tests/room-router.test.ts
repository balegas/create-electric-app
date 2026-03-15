import "dotenv/config"
import "./setup-proxy.js"
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import type { EngineEvent } from "@electric-agent/protocol"
import type { SessionBridge } from "../src/bridge/types.js"
import { RoomRouter } from "../src/room-router.js"
import { getRoomStreamConnectionInfo } from "../src/streams.js"
import { localStreamServer } from "./local-stream-server.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueId(): string {
	return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function waitFor(predicate: () => boolean, timeoutMs = 10_000, intervalMs = 100): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now()
		const check = () => {
			if (predicate()) return resolve()
			if (Date.now() - start > timeoutMs) {
				return reject(new Error(`waitFor timed out after ${timeoutMs}ms`))
			}
			setTimeout(check, intervalMs)
		}
		check()
	})
}

async function ensureStream(url: string, headers: Record<string, string>): Promise<void> {
	const res = await fetch(url, {
		method: "PUT",
		headers: { ...headers, "Content-Type": "application/json" },
	})
	if (!res.ok && res.status !== 409) {
		throw new Error(`Failed to create stream: ${res.status} ${res.statusText}`)
	}
}

/** Mock bridge that records commands and emitted events */
function createMockBridge(sessionId: string): SessionBridge & {
	commands: Array<Record<string, unknown>>
	emitted: EngineEvent[]
} {
	const commands: Array<Record<string, unknown>> = []
	const emitted: EngineEvent[] = []

	return {
		sessionId,
		streamUrl: "",
		streamHeaders: {},
		commands,
		emitted,
		async emit(event: EngineEvent) {
			emitted.push(event)
		},
		async sendCommand(cmd: Record<string, unknown>) {
			commands.push(cmd)
		},
		async sendGateResponse() {},
		onAgentEvent() {},
		onComplete() {},
		async start() {},
		interrupt() {},
		close() {},
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const server = localStreamServer()

describe("RoomRouter", () => {
	before(async () => {
		await server.start()
	})
	after(async () => {
		await server.stop()
	})

	it("adds a participant and sends discovery prompt", async () => {
		const roomId = uniqueId()
		const conn = getRoomStreamConnectionInfo(roomId, server.config)
		await ensureStream(conn.url, conn.headers)

		const router = new RoomRouter(roomId, "Test Room", server.config)
		await router.start()

		const bridge = createMockBridge("sess-alice")
		await router.addParticipant({
			sessionId: "sess-alice",
			name: "alice",
			role: "architect",
			bridge,
		})

		// Bridge should have received a discovery prompt via sendCommand
		assert.equal(bridge.commands.length, 1)
		assert.equal(bridge.commands[0].command, "iterate")
		const request = bridge.commands[0].request as string
		assert.ok(request.includes("Test Room"))
		assert.ok(request.includes("alice"))
		assert.ok(request.includes("architect"))

		assert.equal(router.participants.length, 1)
		assert.equal(router.participants[0].name, "alice")

		router.close()
	})

	it("routes a message from sender to all other participants", async () => {
		const roomId = uniqueId()
		const conn = getRoomStreamConnectionInfo(roomId, server.config)
		await ensureStream(conn.url, conn.headers)

		const router = new RoomRouter(roomId, "Test Room", server.config)
		await router.start()

		const bridgeAlice = createMockBridge("sess-alice")
		const bridgeBob = createMockBridge("sess-bob")

		await router.addParticipant({ sessionId: "sess-alice", name: "alice", bridge: bridgeAlice })
		await router.addParticipant({ sessionId: "sess-bob", name: "bob", bridge: bridgeBob })

		// Clear discovery prompts
		bridgeAlice.commands.length = 0
		bridgeBob.commands.length = 0

		// Alice sends a message via handleAgentOutput
		await router.handleAgentOutput(
			"sess-alice",
			"I did some analysis.\n@room Here are my findings.",
		)

		// Wait for the message to route through the stream to bob
		await waitFor(() => bridgeBob.commands.length >= 1, 5000)

		assert.equal(bridgeBob.commands.length, 1)
		const cmd = bridgeBob.commands[0]
		assert.equal(cmd.command, "iterate")
		assert.ok((cmd.request as string).includes("alice"))
		assert.ok((cmd.request as string).includes("Here are my findings."))

		// Alice should NOT receive her own message
		assert.equal(bridgeAlice.commands.length, 0)

		router.close()
	})

	it("routes a direct message to only the recipient", async () => {
		const roomId = uniqueId()
		const conn = getRoomStreamConnectionInfo(roomId, server.config)
		await ensureStream(conn.url, conn.headers)

		const router = new RoomRouter(roomId, "Test Room", server.config)
		await router.start()

		const bridgeAlice = createMockBridge("sess-alice")
		const bridgeBob = createMockBridge("sess-bob")
		const bridgeCharlie = createMockBridge("sess-charlie")

		await router.addParticipant({ sessionId: "sess-alice", name: "alice", bridge: bridgeAlice })
		await router.addParticipant({ sessionId: "sess-bob", name: "bob", bridge: bridgeBob })
		await router.addParticipant({
			sessionId: "sess-charlie",
			name: "charlie",
			bridge: bridgeCharlie,
		})

		bridgeAlice.commands.length = 0
		bridgeBob.commands.length = 0
		bridgeCharlie.commands.length = 0

		// Alice sends a direct message to bob
		await router.handleAgentOutput("sess-alice", "@bob Check this out.")

		await waitFor(() => bridgeBob.commands.length >= 1, 5000)

		assert.equal(bridgeBob.commands.length, 1)
		assert.ok((bridgeBob.commands[0].request as string).includes("Check this out."))

		// Charlie should NOT receive it
		await new Promise((r) => setTimeout(r, 500))
		assert.equal(bridgeCharlie.commands.length, 0)

		router.close()
	})

	it("returns null (silence) when agent output has no @room", async () => {
		const roomId = uniqueId()
		const conn = getRoomStreamConnectionInfo(roomId, server.config)
		await ensureStream(conn.url, conn.headers)

		const router = new RoomRouter(roomId, "Test Room", server.config)
		await router.start()

		const bridgeAlice = createMockBridge("sess-alice")
		const bridgeBob = createMockBridge("sess-bob")

		await router.addParticipant({ sessionId: "sess-alice", name: "alice", bridge: bridgeAlice })
		await router.addParticipant({ sessionId: "sess-bob", name: "bob", bridge: bridgeBob })

		bridgeBob.commands.length = 0

		// Alice outputs something without @room
		await router.handleAgentOutput(
			"sess-alice",
			"I made some code changes but have nothing to say.",
		)

		await new Promise((r) => setTimeout(r, 500))
		assert.equal(bridgeBob.commands.length, 0, "No message should be delivered")

		router.close()
	})

	it("REVIEW_REQUEST: message does not auto-close the room", async () => {
		const roomId = uniqueId()
		const conn = getRoomStreamConnectionInfo(roomId, server.config)
		await ensureStream(conn.url, conn.headers)

		const router = new RoomRouter(roomId, "Test Room", server.config)
		await router.start()

		const bridgeAlice = createMockBridge("sess-alice")
		await router.addParticipant({ sessionId: "sess-alice", name: "alice", bridge: bridgeAlice })

		assert.equal(router.state, "active")

		await router.handleAgentOutput("sess-alice", "@room REVIEW_REQUEST: Code ready for review.")

		// Room should remain active — no auto-close on REVIEW_REQUEST:
		assert.equal(router.state, "active")

		router.close()
	})

	it("external message delivery via sendMessage", async () => {
		const roomId = uniqueId()
		const conn = getRoomStreamConnectionInfo(roomId, server.config)
		await ensureStream(conn.url, conn.headers)

		const router = new RoomRouter(roomId, "Test Room", server.config)
		await router.start()

		const bridgeAlice = createMockBridge("sess-alice")
		await router.addParticipant({ sessionId: "sess-alice", name: "alice", bridge: bridgeAlice })

		bridgeAlice.commands.length = 0

		// Human sends a message
		await router.sendMessage("human", "Please review the PR.")

		await waitFor(() => bridgeAlice.commands.length >= 1, 5000)

		assert.equal(bridgeAlice.commands.length, 1)
		assert.ok((bridgeAlice.commands[0].request as string).includes("human"))
		assert.ok((bridgeAlice.commands[0].request as string).includes("Please review the PR."))

		router.close()
	})

	it("counts rounds without auto-closing", async () => {
		const roomId = uniqueId()
		const conn = getRoomStreamConnectionInfo(roomId, server.config)
		await ensureStream(conn.url, conn.headers)

		const router = new RoomRouter(roomId, "Test Room", server.config)
		await router.start()

		const bridgeAlice = createMockBridge("sess-alice")
		const bridgeBob = createMockBridge("sess-bob")

		await router.addParticipant({ sessionId: "sess-alice", name: "alice", bridge: bridgeAlice })
		await router.addParticipant({ sessionId: "sess-bob", name: "bob", bridge: bridgeBob })

		// Round 1
		await router.handleAgentOutput("sess-alice", "@room Message 1")
		await waitFor(() => router.roundCount >= 1, 5000)

		// Round 2
		await router.handleAgentOutput("sess-bob", "@room Message 2")
		await waitFor(() => router.roundCount >= 2, 5000)

		// Room should remain active — no auto-close
		assert.equal(router.state, "active")
		assert.equal(router.roundCount, 2)

		router.close()
	})
})
