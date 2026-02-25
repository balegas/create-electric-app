import "dotenv/config"
import "./setup-proxy.js"
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { DurableStream } from "@durable-streams/client"
import type { EngineEvent } from "@electric-agent/protocol"
import { HostedStreamBridge } from "../src/bridge/hosted.js"
import type { StreamMessage } from "../src/bridge/types.js"
import { getStreamConfig, getStreamConnectionInfo, getStreamEnvVars } from "../src/streams.js"
import { localStreamServer } from "./local-stream-server.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueSessionId(): string {
	return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Wait for a condition with timeout */
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

/** Create a stream via the REST API (PUT) */
async function ensureStream(url: string, headers: Record<string, string>): Promise<void> {
	const res = await fetch(url, {
		method: "PUT",
		headers: {
			...headers,
			"Content-Type": "application/json",
		},
	})
	if (!res.ok && res.status !== 409) {
		throw new Error(`Failed to create stream: ${res.status} ${res.statusText}`)
	}
}

// ---------------------------------------------------------------------------
// Tests — config helpers (pure unit tests, no server needed)
// ---------------------------------------------------------------------------

describe("streams — config", () => {
	it("getStreamConfig reads from env vars", () => {
		const config = getStreamConfig()
		if (!config) {
			// When no hosted creds are set, getStreamConfig returns null — that's valid
			assert.equal(config, null)
			return
		}
		assert.ok(config.url.length > 0)
		assert.ok(config.serviceId.length > 0)
		assert.ok(config.secret.length > 0)
	})

	it("getStreamConnectionInfo builds URL with session ID", () => {
		const config = { url: "https://example.com", serviceId: "svc-1", secret: "s3cret" }
		const conn = getStreamConnectionInfo("my-session", config)

		assert.ok(conn.url.includes("svc-1"))
		assert.ok(conn.url.includes("my-session"))
		assert.equal(conn.headers.Authorization, "Bearer s3cret")
	})

	it("getStreamEnvVars builds env map", () => {
		const config = { url: "https://example.com", serviceId: "svc-1", secret: "s3cret" }
		const vars = getStreamEnvVars("my-session", config)

		assert.equal(vars.DS_URL, "https://example.com")
		assert.equal(vars.DS_SERVICE_ID, "svc-1")
		assert.equal(vars.DS_SECRET, "s3cret")
		assert.equal(vars.SESSION_ID, "my-session")
	})
})

// ---------------------------------------------------------------------------
// Tests — stream connectivity (uses local server or hosted)
// ---------------------------------------------------------------------------

const server = localStreamServer()

describe("streams — connectivity", () => {
	before(async () => {
		await server.start()
	})
	after(async () => {
		await server.stop()
	})

	it("can create a stream via PUT", async () => {
		const sessionId = uniqueSessionId()
		const conn = server.connection(sessionId)
		await ensureStream(conn.url, conn.headers)
	})

	it("can write and read back a message", async () => {
		const sessionId = uniqueSessionId()
		const conn = server.connection(sessionId)
		await ensureStream(conn.url, conn.headers)

		const writer = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})

		const testEvent = {
			source: "agent",
			type: "log",
			level: "done",
			message: "integration test",
			ts: new Date().toISOString(),
		}
		await writer.append(JSON.stringify(testEvent))

		const reader = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})
		const response = await reader.stream<StreamMessage>({
			offset: "-1",
			live: false,
		})
		const items = await response.json()

		assert.equal(items.length, 1)
		assert.equal(items[0].source, "agent")
		assert.equal((items[0] as Record<string, unknown>).type, "log")
		assert.equal((items[0] as Record<string, unknown>).message, "integration test")
	})

	it("can write multiple messages and read in order", async () => {
		const sessionId = uniqueSessionId()
		const conn = server.connection(sessionId)
		await ensureStream(conn.url, conn.headers)

		const writer = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})

		for (let i = 0; i < 5; i++) {
			await writer.append(
				JSON.stringify({
					source: "agent",
					type: "log",
					level: "task",
					message: `msg-${i}`,
					ts: new Date().toISOString(),
				}),
			)
		}

		const reader = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})
		const response = await reader.stream<StreamMessage>({
			offset: "-1",
			live: false,
		})
		const items = await response.json()

		assert.equal(items.length, 5)
		for (let i = 0; i < 5; i++) {
			assert.equal((items[i] as Record<string, unknown>).message, `msg-${i}`)
		}
	})
})

// ---------------------------------------------------------------------------
// Tests — bridge roundtrip (uses local server or hosted)
// ---------------------------------------------------------------------------

describe("streams — bridge roundtrip", () => {
	before(async () => {
		await server.start()
	})
	after(async () => {
		await server.stop()
	})

	it("bridge.emit() writes server events to the stream", async () => {
		const sessionId = uniqueSessionId()
		const conn = server.connection(sessionId)
		await ensureStream(conn.url, conn.headers)

		const bridge = new HostedStreamBridge(sessionId, conn)

		const event: EngineEvent = {
			type: "log",
			level: "done",
			message: "bridge emit test",
			ts: new Date().toISOString(),
		}
		await bridge.emit(event)

		const reader = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})
		const response = await reader.stream<StreamMessage>({
			offset: "-1",
			live: false,
		})
		const items = await response.json()

		assert.equal(items.length, 1)
		assert.equal(items[0].source, "server")
		assert.equal((items[0] as Record<string, unknown>).type, "log")
		bridge.close()
	})

	it("bridge.sendCommand() writes command to the stream", async () => {
		const sessionId = uniqueSessionId()
		const conn = server.connection(sessionId)
		await ensureStream(conn.url, conn.headers)

		const bridge = new HostedStreamBridge(sessionId, conn)

		await bridge.sendCommand({
			command: "new",
			description: "test app",
		})

		const reader = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})
		const response = await reader.stream<StreamMessage>({
			offset: "-1",
			live: false,
		})
		const items = await response.json()

		assert.equal(items.length, 1)
		assert.equal(items[0].source, "server")
		assert.equal((items[0] as Record<string, unknown>).type, "command")
		assert.equal((items[0] as Record<string, unknown>).command, "new")
		bridge.close()
	})

	it("bridge.sendGateResponse() writes gate response to the stream", async () => {
		const sessionId = uniqueSessionId()
		const conn = server.connection(sessionId)
		await ensureStream(conn.url, conn.headers)

		const bridge = new HostedStreamBridge(sessionId, conn)

		await bridge.sendGateResponse("approval", { decision: "approve" })

		const reader = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})
		const response = await reader.stream<StreamMessage>({
			offset: "-1",
			live: false,
		})
		const items = await response.json()

		assert.equal(items.length, 1)
		assert.equal(items[0].source, "server")
		assert.equal((items[0] as Record<string, unknown>).type, "gate_response")
		assert.equal((items[0] as Record<string, unknown>).gate, "approval")
		bridge.close()
	})

	it("bridge.onAgentEvent() receives agent events via subscription", async () => {
		const sessionId = uniqueSessionId()
		const conn = server.connection(sessionId)
		await ensureStream(conn.url, conn.headers)

		const bridge = new HostedStreamBridge(sessionId, conn)

		const received: EngineEvent[] = []
		bridge.onAgentEvent((event) => {
			received.push(event)
		})

		await bridge.start()

		// Simulate an agent writing to the stream
		const agentWriter = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})
		await agentWriter.append(
			JSON.stringify({
				source: "agent",
				type: "log",
				level: "task",
				message: "hello from agent",
				ts: new Date().toISOString(),
			}),
		)

		await waitFor(() => received.length >= 1, 10_000)

		assert.equal(received.length, 1)
		assert.equal(received[0].type, "log")
		assert.equal((received[0] as EngineEvent & { message: string }).message, "hello from agent")
		// The source field should be stripped
		assert.equal((received[0] as Record<string, unknown>).source, undefined)
		bridge.close()
	})

	it("bridge filters out server messages from onAgentEvent", async () => {
		const sessionId = uniqueSessionId()
		const conn = server.connection(sessionId)
		await ensureStream(conn.url, conn.headers)

		const bridge = new HostedStreamBridge(sessionId, conn)

		const received: EngineEvent[] = []
		bridge.onAgentEvent((event) => {
			received.push(event)
		})

		await bridge.start()

		// Write both server and agent messages
		const writer = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})
		await writer.append(
			JSON.stringify({
				source: "server",
				type: "command",
				command: "new",
				ts: new Date().toISOString(),
			}),
		)
		await writer.append(
			JSON.stringify({
				source: "agent",
				type: "log",
				level: "done",
				message: "agent only",
				ts: new Date().toISOString(),
			}),
		)

		await waitFor(() => received.length >= 1, 10_000)
		await new Promise((r) => setTimeout(r, 500))

		assert.equal(received.length, 1, "Should only receive agent messages")
		assert.equal((received[0] as EngineEvent & { message: string }).message, "agent only")
		bridge.close()
	})

	it("SSE proxy filter: passes server EngineEvents, blocks protocol messages", async () => {
		const sessionId = uniqueSessionId()
		const conn = server.connection(sessionId)
		await ensureStream(conn.url, conn.headers)

		const bridge = new HostedStreamBridge(sessionId, conn)

		// Server emits EngineEvents (should pass SSE proxy)
		await bridge.emit({
			type: "infra_config_prompt",
			projectName: "test-project",
			ghAccounts: [],
			runtime: "docker",
			ts: new Date().toISOString(),
		})
		await bridge.emit({
			type: "user_prompt",
			message: "build a todo app",
			ts: new Date().toISOString(),
		})
		// Server sends protocol messages (should be blocked by SSE proxy)
		await bridge.sendCommand({ command: "new", description: "test" })
		await bridge.sendGateResponse("approval", { decision: "approve" })

		// Read all messages from the stream
		const reader = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})
		const response = await reader.stream<StreamMessage>({
			offset: "-1",
			live: false,
		})
		const items = await response.json()

		assert.equal(items.length, 4, "Should have 4 messages total")

		// Apply the same filtering the SSE proxy uses (server.ts)
		const proxyFiltered = items.filter((item) => {
			const msgType = (item as Record<string, unknown>).type as string
			return msgType !== "command" && msgType !== "gate_response"
		})

		assert.equal(proxyFiltered.length, 2, "SSE proxy should pass 2 events")
		assert.equal(
			(proxyFiltered[0] as Record<string, unknown>).type,
			"infra_config_prompt",
			"infra_config_prompt should NOT be filtered",
		)
		assert.equal(
			(proxyFiltered[1] as Record<string, unknown>).type,
			"user_prompt",
			"user_prompt should NOT be filtered",
		)

		bridge.close()
	})

	it("bridge.onComplete() fires on session_end", async () => {
		const sessionId = uniqueSessionId()
		const conn = server.connection(sessionId)
		await ensureStream(conn.url, conn.headers)

		const bridge = new HostedStreamBridge(sessionId, conn)

		let completedWith: boolean | null = null
		bridge.onComplete((success) => {
			completedWith = success
		})

		await bridge.start()

		const agentWriter = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})
		await agentWriter.append(
			JSON.stringify({
				source: "agent",
				type: "session_end",
				success: true,
				ts: new Date().toISOString(),
			}),
		)

		await waitFor(() => completedWith !== null, 10_000)

		assert.equal(completedWith, true)
		bridge.close()
	})
})
