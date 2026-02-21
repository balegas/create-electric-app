import "dotenv/config"
import "./setup-proxy.js"
import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { DurableStream } from "@durable-streams/client"
import { HostedStreamBridge } from "../src/web/bridge/hosted.js"
import {
	getStreamConfig,
	getStreamConnectionInfo,
	getStreamEnvVars,
} from "../src/web/streams.js"
import type { StreamMessage } from "../src/web/bridge/types.js"
import type { EngineEvent } from "../src/engine/events.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueSessionId(): string {
	return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Wait for a condition with timeout */
function waitFor(
	predicate: () => boolean,
	timeoutMs = 10_000,
	intervalMs = 100,
): Promise<void> {
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

/**
 * Create a stream via the REST API (PUT) since DurableStream.create()
 * may not be supported by the hosted service. Falls back to append.
 */
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
// Tests
// ---------------------------------------------------------------------------

describe("streams — config", () => {
	it("reads hosted stream config from env vars", () => {
		const config = getStreamConfig()
		assert.ok(config, "DS_URL, DS_SERVICE_ID, DS_SECRET must be set in .env")
		assert.ok(config.url.startsWith("https://"), "DS_URL should be HTTPS")
		assert.ok(config.serviceId.length > 0, "DS_SERVICE_ID should be non-empty")
		assert.ok(config.secret.length > 0, "DS_SECRET should be non-empty")
	})

	it("builds connection info with auth headers", () => {
		const config = getStreamConfig()!
		const conn = getStreamConnectionInfo("test-session", config)

		assert.ok(
			conn.url.includes(config.serviceId),
			"URL should contain service ID",
		)
		assert.ok(
			conn.url.includes("test-session"),
			"URL should contain session ID",
		)
		assert.ok(
			conn.headers.Authorization?.startsWith("Bearer "),
			"Should include Bearer auth header",
		)
	})

	it("builds sandbox env vars", () => {
		const config = getStreamConfig()!
		const vars = getStreamEnvVars("my-session", config)

		assert.equal(vars.DS_URL, config.url)
		assert.equal(vars.DS_SERVICE_ID, config.serviceId)
		assert.equal(vars.DS_SECRET, config.secret)
		assert.equal(vars.SESSION_ID, "my-session")
	})

	it("builds env vars with session ID", () => {
		const config = getStreamConfig()!
		const vars = getStreamEnvVars("env-test-session", config)

		assert.equal(vars.SESSION_ID, "env-test-session")
		assert.equal(vars.DS_URL, config.url)
	})
})

describe("streams — hosted service connectivity", () => {
	const config = getStreamConfig()
	if (!config) {
		it("SKIP: no hosted stream credentials configured", () => {
			assert.ok(true)
		})
		return
	}

	it("can create a stream via PUT", async () => {
		const sessionId = uniqueSessionId()
		const conn = getStreamConnectionInfo(sessionId, config)
		await ensureStream(conn.url, conn.headers)
	})

	it("can write and read back a message", async () => {
		const sessionId = uniqueSessionId()
		const conn = getStreamConnectionInfo(sessionId, config)
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

		// Read back
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
		assert.equal(
			(items[0] as Record<string, unknown>).message,
			"integration test",
		)
	})

	it("can write multiple messages and read in order", async () => {
		const sessionId = uniqueSessionId()
		const conn = getStreamConnectionInfo(sessionId, config)
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
			assert.equal(
				(items[i] as Record<string, unknown>).message,
				`msg-${i}`,
			)
		}
	})
})

describe("streams — bridge roundtrip", () => {
	const config = getStreamConfig()
	if (!config) {
		it("SKIP: no hosted stream credentials configured", () => {
			assert.ok(true)
		})
		return
	}

	it("bridge.emit() writes server events to the stream", async () => {
		const sessionId = uniqueSessionId()
		const conn = getStreamConnectionInfo(sessionId, config)
		await ensureStream(conn.url, conn.headers)

		const bridge = new HostedStreamBridge(sessionId, conn)

		const event: EngineEvent = {
			type: "log",
			level: "done",
			message: "bridge emit test",
			ts: new Date().toISOString(),
		}
		await bridge.emit(event)

		// Read raw stream — should see source: "server"
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
		const conn = getStreamConnectionInfo(sessionId, config)
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
		const conn = getStreamConnectionInfo(sessionId, config)
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
		const conn = getStreamConnectionInfo(sessionId, config)
		await ensureStream(conn.url, conn.headers)

		const bridge = new HostedStreamBridge(sessionId, conn)

		const received: EngineEvent[] = []
		bridge.onAgentEvent((event) => {
			received.push(event)
		})

		await bridge.start()

		// Simulate an agent writing to the stream (as the sandbox would)
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
		assert.equal(
			(received[0] as EngineEvent & { message: string }).message,
			"hello from agent",
		)
		// The source field should be stripped
		assert.equal(
			(received[0] as Record<string, unknown>).source,
			undefined,
		)
		bridge.close()
	})

	it("bridge filters out server messages from onAgentEvent", async () => {
		const sessionId = uniqueSessionId()
		const conn = getStreamConnectionInfo(sessionId, config)
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
		// Give a moment for any additional (incorrect) messages
		await new Promise((r) => setTimeout(r, 500))

		assert.equal(received.length, 1, "Should only receive agent messages")
		assert.equal(
			(received[0] as EngineEvent & { message: string }).message,
			"agent only",
		)
		bridge.close()
	})

	it("bridge.onComplete() fires on session_complete", async () => {
		const sessionId = uniqueSessionId()
		const conn = getStreamConnectionInfo(sessionId, config)
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
				type: "session_complete",
				success: true,
				ts: new Date().toISOString(),
			}),
		)

		await waitFor(() => completedWith !== null, 10_000)

		assert.equal(completedWith, true)
		bridge.close()
	})
})
