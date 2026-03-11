import "dotenv/config"
import "./setup-proxy.js"
import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import { before, describe, it } from "node:test"
import type { EngineEvent } from "@electric-agent/protocol"
import { HostedStreamBridge } from "@electric-agent/studio/bridge"
import type { StreamConfig } from "@electric-agent/studio/streams"
import { getStreamConfig, getStreamConnectionInfo } from "@electric-agent/studio/streams"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueSessionId(): string {
	return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Test-only: build env vars for a sandbox container that connects directly to DS.
 * In production, DS_SECRET never leaves the server — sandboxes use the studio API proxy.
 */
function testStreamEnvVars(sessionId: string, config: StreamConfig): Record<string, string> {
	return {
		DS_URL: config.url,
		DS_SERVICE_ID: config.serviceId,
		DS_SECRET: config.secret,
		SESSION_ID: sessionId,
	}
}

function isDockerAvailable(): boolean {
	try {
		execSync("docker info", { stdio: "ignore", timeout: 5000 })
		return true
	} catch {
		return false
	}
}

function isTestImageBuilt(): boolean {
	try {
		const output = execSync("docker images -q electric-agent-test-sandbox", {
			encoding: "utf-8",
			timeout: 5000,
		}).trim()
		return output.length > 0
	} catch {
		return false
	}
}

/** Wait for a condition with timeout */
function waitFor(predicate: () => boolean, timeoutMs = 30_000, intervalMs = 200): Promise<void> {
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
const dockerAvailable = isDockerAvailable()
const skipReason = !streamConfig
	? "No hosted stream credentials configured"
	: !dockerAvailable
		? "Docker not available"
		: null

describe("e2e-docker — test sandbox via stream bridge", { skip: skipReason ?? false }, () => {
	// Build test image if not already built
	before(() => {
		if (!isTestImageBuilt()) {
			console.log("Building test sandbox image...")
			execSync("npm run build:test-sandbox", {
				stdio: "pipe",
				timeout: 120_000,
			})
		}
	})

	it(
		"full roundtrip: create container, send command, receive echo, destroy",
		{ timeout: 120_000 },
		async () => {
			if (!streamConfig) throw new Error("streamConfig is not available")
			const config = streamConfig
			const sessionId = uniqueSessionId()
			const conn = getStreamConnectionInfo(sessionId, config)
			const streamEnv = testStreamEnvVars(sessionId, config)

			// Create the stream
			await ensureStream(conn.url, conn.headers)

			// Create bridge and start listening for agent events
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

			// Run test sandbox container directly (not via DockerSandboxProvider, which uses the real image)
			const containerName = `e2e-test-${sessionId.slice(0, 12)}`
			const envFlags = Object.entries(streamEnv)
				.map(([k, v]) => `-e ${k}=${v}`)
				.join(" ")

			try {
				// Start test container in background
				execSync(`docker run -d --name ${containerName} ${envFlags} electric-agent-test-sandbox`, {
					stdio: "pipe",
					timeout: 30_000,
				})

				// Wait a moment for the container to start and connect to the stream
				await new Promise((r) => setTimeout(r, 2000))

				// Send a command via the bridge
				await bridge.sendCommand({
					command: "new",
					description: "e2e test app",
					projectName: "test-project",
				})

				// Wait for the test agent to echo back and send session_complete
				await waitFor(() => completedWith !== null, 30_000)

				// Verify we received events
				assert.ok(receivedEvents.length >= 1, "Should have received at least one event")

				// Check for echo_config event
				const echoConfig = receivedEvents.find((e) => e.type === "echo_config") as
					| Record<string, unknown>
					| undefined
				assert.ok(echoConfig, "Should have received echo_config event")
				assert.equal(echoConfig?.command, "new")
				assert.equal(echoConfig?.description, "e2e test app")

				// Check session_complete
				assert.equal(completedWith, true, "Session should complete successfully")
			} finally {
				// Clean up container
				try {
					execSync(`docker rm -f ${containerName}`, { stdio: "ignore", timeout: 10_000 })
				} catch {
					// Best effort
				}
				bridge.close()
			}
		},
	)

	it("test sandbox echoes iterate commands", { timeout: 60_000 }, async () => {
		if (!streamConfig) throw new Error("streamConfig is not available")
		const config = streamConfig
		const sessionId = uniqueSessionId()
		const conn = getStreamConnectionInfo(sessionId, config)
		const streamEnv = testStreamEnvVars(sessionId, config)

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

		const containerName = `e2e-iter-${sessionId.slice(0, 12)}`
		const envFlags = Object.entries(streamEnv)
			.map(([k, v]) => `-e ${k}=${v}`)
			.join(" ")

		try {
			execSync(`docker run -d --name ${containerName} ${envFlags} electric-agent-test-sandbox`, {
				stdio: "pipe",
				timeout: 30_000,
			})

			await new Promise((r) => setTimeout(r, 2000))

			// Send initial config
			await bridge.sendCommand({
				command: "new",
				description: "test app",
			})

			// Wait for first completion
			await waitFor(() => completeCount >= 1, 30_000)

			// Send iterate command
			await bridge.sendCommand({
				command: "iterate",
				request: "add a button",
				projectDir: "/tmp/test",
			})

			// Wait for second completion
			await waitFor(() => completeCount >= 2, 30_000)

			// Verify iterate command was echoed
			const echoCommands = receivedEvents.filter((e) => e.type === "echo_command") as Record<
				string,
				unknown
			>[]
			assert.ok(echoCommands.length >= 1, "Should have received echo_command for iterate")
			assert.equal(echoCommands[0]?.command, "iterate")
		} finally {
			try {
				execSync(`docker rm -f ${containerName}`, { stdio: "ignore", timeout: 10_000 })
			} catch {
				// Best effort
			}
			bridge.close()
		}
	})
})
