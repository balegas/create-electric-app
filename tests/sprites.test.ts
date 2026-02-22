import "dotenv/config"
import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { SpritesSandboxProvider } from "../src/web/sandbox/sprites.js"
import type { SandboxHandle, SandboxProvider } from "../src/web/sandbox/types.js"

// ---------------------------------------------------------------------------
// SpritesSandboxProvider — unit tests (no FLY_API_TOKEN needed)
// ---------------------------------------------------------------------------

describe("SpritesSandboxProvider — interface", () => {
	it("implements SandboxProvider interface", () => {
		const provider: SandboxProvider = new SpritesSandboxProvider({
			token: "fake-token",
		})
		assert.equal(provider.runtime, "sprites")
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
		const provider = new SpritesSandboxProvider({ token: "fake" })
		assert.equal(provider.get("nonexistent"), undefined)
	})

	it("list() returns empty array initially", () => {
		const provider = new SpritesSandboxProvider({ token: "fake" })
		assert.deepEqual(provider.list(), [])
	})

	it("isAlive() returns false for unknown handle", () => {
		const provider = new SpritesSandboxProvider({ token: "fake" })
		const fakeHandle: SandboxHandle = {
			sessionId: "fake",
			runtime: "sprites",
			port: 5173,
			projectDir: "/tmp",
		}
		assert.equal(provider.isAlive(fakeHandle), false)
	})

	it("listFiles returns empty for unknown handle", async () => {
		const provider = new SpritesSandboxProvider({ token: "fake" })
		const fakeHandle: SandboxHandle = {
			sessionId: "fake",
			runtime: "sprites",
			port: 5173,
			projectDir: "/tmp",
		}
		const files = await provider.listFiles(fakeHandle, "/tmp")
		assert.deepEqual(files, [])
	})

	it("readFile returns null for unknown handle", async () => {
		const provider = new SpritesSandboxProvider({ token: "fake" })
		const fakeHandle: SandboxHandle = {
			sessionId: "fake",
			runtime: "sprites",
			port: 5173,
			projectDir: "/tmp",
		}
		const content = await provider.readFile(fakeHandle, "/tmp/foo.txt")
		assert.equal(content, null)
	})

	it("gitStatus returns uninitialized for unknown handle", async () => {
		const provider = new SpritesSandboxProvider({ token: "fake" })
		const fakeHandle: SandboxHandle = {
			sessionId: "fake",
			runtime: "sprites",
			port: 5173,
			projectDir: "/tmp",
		}
		const status = await provider.gitStatus(fakeHandle, "/tmp")
		assert.equal(status.initialized, false)
		assert.equal(status.branch, null)
	})

	it("getSpriteObject returns undefined for unknown session", () => {
		const provider = new SpritesSandboxProvider({ token: "fake" })
		assert.equal(provider.getSpriteObject("nonexistent"), undefined)
	})
})

// ---------------------------------------------------------------------------
// SpritesSandboxProvider — integration tests (require FLY_API_TOKEN)
// ---------------------------------------------------------------------------

const spritesToken = process.env.SPRITES_TEST_TOKEN?.trim() || process.env.FLY_API_TOKEN?.trim()

describe("SpritesSandboxProvider — integration", { skip: !spritesToken }, () => {
	it("create → exec → destroy", async () => {
		const provider = new SpritesSandboxProvider({ token: spritesToken })
		const handle = await provider.create("test-sprites-integration", {
			projectName: "test-project",
		})

		assert.equal(handle.runtime, "sprites")
		assert.equal(handle.sessionId, "test-sprites-integration")
		assert.ok(handle.previewUrl)

		// Exec a simple command
		const result = await provider.exec(handle, "echo hello")
		assert.equal(result, "hello")

		// Cleanup
		await provider.destroy(handle)
		assert.equal(provider.get("test-sprites-integration"), undefined)
	})
})
