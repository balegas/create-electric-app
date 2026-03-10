import "dotenv/config"
import "./setup-proxy.js"
import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { DockerSandboxProvider } from "../src/sandbox/docker.js"
import type { SandboxHandle, SandboxProvider } from "../src/sandbox/types.js"

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
