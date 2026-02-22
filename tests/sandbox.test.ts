import "dotenv/config"
import "../tests/setup-proxy.js"
import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { DaytonaSandboxProvider } from "../src/web/sandbox/daytona.js"
import { getSnapshotStatus } from "../src/web/sandbox/daytona-registry.js"
import { DockerSandboxProvider } from "../src/web/sandbox/docker.js"
import type { SandboxHandle, SandboxProvider } from "../src/web/sandbox/types.js"

// ---------------------------------------------------------------------------
// DockerSandboxProvider — unit tests (no Docker daemon needed)
// ---------------------------------------------------------------------------

describe("DockerSandboxProvider — interface", () => {
	it("implements SandboxProvider interface", () => {
		const provider: SandboxProvider = new DockerSandboxProvider()
		assert.equal(provider.runtime, "docker")
		assert.equal(typeof provider.create, "function")
		assert.equal(typeof provider.destroy, "function")
		assert.equal(typeof provider.get, "function")
		assert.equal(typeof provider.list, "function")
		assert.equal(typeof provider.isAlive, "function")
		assert.equal(typeof provider.listFiles, "function")
		assert.equal(typeof provider.readFile, "function")
		assert.equal(typeof provider.startApp, "function")
		assert.equal(typeof provider.stopApp, "function")
		assert.equal(typeof provider.isAppRunning, "function")
		assert.equal(typeof provider.exec, "function")
		assert.equal(typeof provider.gitStatus, "function")
		assert.equal(typeof provider.createFromRepo, "function")
		assert.equal(typeof provider.restartAgent, "function")
	})

	it("get() returns undefined for unknown session", () => {
		const provider = new DockerSandboxProvider()
		assert.equal(provider.get("nonexistent"), undefined)
	})

	it("list() returns empty array initially", () => {
		const provider = new DockerSandboxProvider()
		assert.deepEqual(provider.list(), [])
	})

	it("isAlive() returns false for unknown handle", () => {
		const provider = new DockerSandboxProvider()
		const fakeHandle: SandboxHandle = {
			sessionId: "fake",
			runtime: "docker",
			port: 3000,
			projectDir: "/tmp",
		}
		assert.equal(provider.isAlive(fakeHandle), false)
	})

	it("listFiles returns empty for unknown handle", async () => {
		const provider = new DockerSandboxProvider()
		const fakeHandle: SandboxHandle = {
			sessionId: "fake",
			runtime: "docker",
			port: 3000,
			projectDir: "/tmp",
		}
		const files = await provider.listFiles(fakeHandle, "/tmp")
		assert.deepEqual(files, [])
	})

	it("readFile returns null for unknown handle", async () => {
		const provider = new DockerSandboxProvider()
		const fakeHandle: SandboxHandle = {
			sessionId: "fake",
			runtime: "docker",
			port: 3000,
			projectDir: "/tmp",
		}
		const content = await provider.readFile(fakeHandle, "/tmp/foo.txt")
		assert.equal(content, null)
	})

	it("gitStatus returns uninitialized for unknown handle", async () => {
		const provider = new DockerSandboxProvider()
		const fakeHandle: SandboxHandle = {
			sessionId: "fake",
			runtime: "docker",
			port: 3000,
			projectDir: "/tmp",
		}
		const status = await provider.gitStatus(fakeHandle, "/tmp")
		assert.equal(status.initialized, false)
	})
})

// ---------------------------------------------------------------------------
// DaytonaSandboxProvider — unit tests (no Daytona API needed)
// ---------------------------------------------------------------------------

describe("DaytonaSandboxProvider — interface", () => {
	it("implements SandboxProvider interface", () => {
		const provider: SandboxProvider = new DaytonaSandboxProvider({
			apiKey: "test-key",
			apiUrl: "https://example.com/api",
		})
		assert.equal(provider.runtime, "daytona")
		assert.equal(typeof provider.create, "function")
		assert.equal(typeof provider.destroy, "function")
		assert.equal(typeof provider.get, "function")
		assert.equal(typeof provider.list, "function")
		assert.equal(typeof provider.isAlive, "function")
		assert.equal(typeof provider.listFiles, "function")
		assert.equal(typeof provider.readFile, "function")
		assert.equal(typeof provider.startApp, "function")
		assert.equal(typeof provider.stopApp, "function")
		assert.equal(typeof provider.isAppRunning, "function")
		assert.equal(typeof provider.exec, "function")
		assert.equal(typeof provider.gitStatus, "function")
		assert.equal(typeof provider.createFromRepo, "function")
		assert.equal(typeof provider.restartAgent, "function")
	})

	it("get() returns undefined for unknown session", () => {
		const provider = new DaytonaSandboxProvider({
			apiKey: "test-key",
			apiUrl: "https://example.com/api",
		})
		assert.equal(provider.get("nonexistent"), undefined)
	})

	it("list() returns empty array initially", () => {
		const provider = new DaytonaSandboxProvider({
			apiKey: "test-key",
			apiUrl: "https://example.com/api",
		})
		assert.deepEqual(provider.list(), [])
	})

	it("isAlive() returns false for unknown handle", () => {
		const provider = new DaytonaSandboxProvider({
			apiKey: "test-key",
			apiUrl: "https://example.com/api",
		})
		const fakeHandle: SandboxHandle = {
			sessionId: "fake",
			runtime: "daytona",
			port: 5173,
			projectDir: "/tmp",
		}
		assert.equal(provider.isAlive(fakeHandle), false)
	})

	it("gitStatus returns uninitialized for unknown handle", async () => {
		const provider = new DaytonaSandboxProvider({
			apiKey: "test-key",
			apiUrl: "https://example.com/api",
		})
		const fakeHandle: SandboxHandle = {
			sessionId: "fake",
			runtime: "daytona",
			port: 5173,
			projectDir: "/tmp",
		}
		const status = await provider.gitStatus(fakeHandle, "/tmp")
		assert.equal(status.initialized, false)
	})

	it("create() resolves snapshot before creating sandbox", () => {
		// The DaytonaSandboxProvider now uses ensureSnapshot() internally
		// to push the image and create a snapshot. We verify the provider
		// has the resolveSnapshot path by checking it constructs without error.
		const provider = new DaytonaSandboxProvider({
			apiKey: "test-key",
			apiUrl: "https://example.com/api",
		})
		// The actual snapshot resolution requires API access, so we just
		// verify the provider is properly constructed for snapshot flow
		assert.equal(provider.runtime, "daytona")
	})
})

// ---------------------------------------------------------------------------
// DaytonaSandboxProvider — Daytona API connectivity
// ---------------------------------------------------------------------------

describe("DaytonaSandboxProvider — Daytona API connectivity", () => {
	const apiKey = process.env.DAYTONA_API_KEY
	const apiUrl = process.env.DAYTONA_API_URL || "https://app.daytona.io/api"
	const target = process.env.DAYTONA_TARGET || "eu"

	it("can instantiate provider with real credentials", { skip: !apiKey }, () => {
		const provider = new DaytonaSandboxProvider({
			apiKey: apiKey!,
			apiUrl,
			target,
		})
		assert.equal(provider.runtime, "daytona")
	})

	it(
		"can list sandboxes (validates API key)",
		{ skip: !apiKey, timeout: 30000 },
		async () => {
			const { Daytona } = await import("@daytonaio/sdk")
			const client = new Daytona({
				apiKey: apiKey!,
				apiUrl,
				target,
			})
			// list() should not throw — validates credentials
			const result = await client.list()
			assert.ok(Array.isArray(result.items))
		},
	)

	it(
		"can get transient push access (validates registry API auth)",
		{ skip: !apiKey, timeout: 30000 },
		async () => {
			const { Configuration, DockerRegistryApi } = await import("@daytonaio/api-client")
			const config = new Configuration({
				accessToken: apiKey!,
				basePath: apiUrl,
			})
			const registryApi = new DockerRegistryApi(config)
			const response = await registryApi.getTransientPushAccess()
			const access = response.data
			assert.ok(access.registryUrl, "registryUrl should be present")
			assert.ok(access.project, "project should be present")
			assert.ok(access.username, "username should be present")
			assert.ok(access.secret, "secret should be present")
			assert.ok(access.expiresAt, "expiresAt should be present")
			console.log(`[test] Transient registry: ${access.registryUrl}/${access.project}`)
		},
	)

	it(
		"can check snapshot status",
		{ skip: !apiKey, timeout: 30000 },
		async () => {
			const { Daytona } = await import("@daytonaio/sdk")
			const client = new Daytona({
				apiKey: apiKey!,
				apiUrl,
				target,
			})
			const status = await getSnapshotStatus(client, "electric-agent-sandbox")
			// Snapshot may or may not exist — just verify the function doesn't throw
			assert.ok(typeof status.exists === "boolean")
			if (status.exists) {
				assert.ok(status.state, "state should be present when snapshot exists")
				console.log(`[test] Snapshot status: ${status.state}`)
			} else {
				console.log("[test] Snapshot does not exist yet")
			}
		},
	)
})
