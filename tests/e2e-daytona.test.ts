import "dotenv/config"
import "./setup-proxy.js"
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { HostedStreamBridge } from "../src/bridge/hosted.js"
import { DaytonaSandboxProvider } from "../src/sandbox/daytona.js"
import type { EngineEvent } from "../src/engine/events.js"
import {
	getStreamConfig,
	getStreamConnectionInfo,
	getStreamEnvVars,
} from "../src/studio/streams.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueSessionId(): string {
	return `e2e-dtn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Wait for a condition with timeout */
function waitFor(
	predicate: () => boolean,
	timeoutMs = 60_000,
	intervalMs = 500,
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

/** Create a stream via the REST API */
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

const streamConfig = getStreamConfig()
const daytonaApiKey = process.env.DAYTONA_API_KEY
const skipReason = !streamConfig
	? "No hosted stream credentials configured"
	: !daytonaApiKey
		? "DAYTONA_API_KEY not set"
		: null

// Use SANDBOX_IMAGE env var to point at the test sandbox image on Docker Hub
const testImage = process.env.SANDBOX_IMAGE
if (!testImage && !skipReason) {
	console.log(
		"Hint: set SANDBOX_IMAGE to your Docker Hub test sandbox image " +
			"(e.g. youruser/electric-agent-test-sandbox) for Daytona e2e tests",
	)
}

describe(
	"e2e-daytona — test sandbox via Daytona + stream bridge",
	{ skip: skipReason ?? (!testImage ? "SANDBOX_IMAGE not set" : false) },
	() => {
		it(
			"full roundtrip: create Daytona sandbox, send command, receive echo, destroy",
			{ timeout: 180_000 },
			async () => {
				const config = streamConfig!
				const sessionId = uniqueSessionId()
				const conn = getStreamConnectionInfo(sessionId, config)
				const streamEnv = getStreamEnvVars(sessionId, config)

				// Create the stream
				await ensureStream(conn.url, conn.headers)

				// Create bridge and start listening
				const bridge = new HostedStreamBridge(sessionId, conn)
				const receivedEvents: EngineEvent[] = []
				let completedWith: boolean | null = null

				bridge.onAgentEvent((event) => {
					receivedEvents.push(event)
				})
				bridge.onComplete((success) => {
					completedWith = success
				})
				await bridge.start()

				// Create Daytona sandbox with test image
				const provider = new DaytonaSandboxProvider()
				const handle = await provider.create(sessionId, {
					projectName: "e2e-daytona-test",
					streamEnv,
				})

				try {
					// Wait for the sandbox to boot and connect
					await new Promise((r) => setTimeout(r, 10_000))

					// Send a command via the bridge
					await bridge.sendCommand({
						command: "new",
						description: "e2e daytona test app",
						projectName: "test-project",
					})

					// Wait for the test agent to echo back and send session_complete
					await waitFor(() => completedWith !== null, 90_000)

					// Verify we received events
					assert.ok(receivedEvents.length >= 1, "Should have received at least one event")

					// Check for echo_config event
					const echoConfig = receivedEvents.find(
						(e) => e.type === "echo_config",
					) as Record<string, unknown> | undefined
					assert.ok(echoConfig, "Should have received echo_config event")
					assert.equal(echoConfig?.command, "new")
					assert.equal(echoConfig?.description, "e2e daytona test app")

					// Check session_complete
					assert.equal(completedWith, true, "Session should complete successfully")
				} finally {
					await provider.destroy(handle)
					bridge.close()
				}
			},
		)

		it(
			"Daytona sandbox echoes iterate commands",
			{ timeout: 180_000 },
			async () => {
				const config = streamConfig!
				const sessionId = uniqueSessionId()
				const conn = getStreamConnectionInfo(sessionId, config)
				const streamEnv = getStreamEnvVars(sessionId, config)

				await ensureStream(conn.url, conn.headers)

				const bridge = new HostedStreamBridge(sessionId, conn)
				const receivedEvents: EngineEvent[] = []
				let completeCount = 0

				bridge.onAgentEvent((event) => {
					receivedEvents.push(event)
				})
				bridge.onComplete(() => {
					completeCount++
				})
				await bridge.start()

				const provider = new DaytonaSandboxProvider()
				const handle = await provider.create(sessionId, {
					projectName: "e2e-daytona-iter",
					streamEnv,
				})

				try {
					await new Promise((r) => setTimeout(r, 10_000))

					// Send initial config
					await bridge.sendCommand({
						command: "new",
						description: "test app",
					})

					// Wait for first completion
					await waitFor(() => completeCount >= 1, 90_000)

					// Send iterate command
					await bridge.sendCommand({
						command: "iterate",
						request: "add a button",
						projectDir: "/tmp/test",
					})

					// Wait for second completion
					await waitFor(() => completeCount >= 2, 90_000)

					// Verify iterate command was echoed
					const echoCommands = receivedEvents.filter(
						(e) => e.type === "echo_command",
					) as Record<string, unknown>[]
					assert.ok(
						echoCommands.length >= 1,
						"Should have received echo_command for iterate",
					)
					assert.equal(echoCommands[0]?.command, "iterate")
				} finally {
					await provider.destroy(handle)
					bridge.close()
				}
			},
		)
	},
)
