import "dotenv/config"
import { strict as assert } from "node:assert"
import { after, describe, it } from "node:test"
import { SpritesSandboxProvider } from "../src/sandbox/sprites.js"
import type { SandboxHandle, SandboxProvider } from "../src/sandbox/types.js"

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
// Helper
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// SpritesSandboxProvider — integration tests (require FLY_API_TOKEN)
// ---------------------------------------------------------------------------

const spritesToken = process.env.SPRITES_TEST_TOKEN?.trim() || process.env.FLY_API_TOKEN?.trim()

describe("SpritesSandboxProvider — integration", { skip: !spritesToken }, () => {
	const INTEGRATION_ID = `test-int-${Date.now().toString(36)}`
	let provider: SpritesSandboxProvider
	let handle: SandboxHandle | undefined

	after(async () => {
		if (handle && provider) {
			try {
				await provider.destroy(handle)
			} catch {
				// Best-effort cleanup
			}
		}
	})

	it("create → exec → destroy", { timeout: 180_000 }, async () => {
		provider = new SpritesSandboxProvider({ token: spritesToken })
		handle = await provider.create(INTEGRATION_ID, {
			projectName: "test-project",
		})

		assert.equal(handle.runtime, "sprites")
		assert.equal(handle.sessionId, INTEGRATION_ID)
		assert.ok(handle.previewUrl)

		// Exec a simple command
		const result = await provider.exec(handle, "echo hello")
		assert.equal(result, "hello")

		// Verify env vars were written correctly
		const envCheck = await provider.exec(handle, "cat /etc/profile.d/electric-agent.sh")
		assert.ok(
			envCheck.includes("SANDBOX_MODE"),
			`env file should contain SANDBOX_MODE, got: ${envCheck}`,
		)

		// Cleanup
		await provider.destroy(handle)
		handle = undefined
		assert.equal(provider.get(INTEGRATION_ID), undefined)
	})
})

// ---------------------------------------------------------------------------
// Sprites agent I/O — end-to-end test (require FLY_API_TOKEN)
//
// Creates a real sprite, starts the headless agent, sends a config command
// via stdin, and reads NDJSON events from stdout to verify the full I/O
// pipeline works. No ANTHROPIC_API_KEY needed — we send a "git" command
// that the headless agent handles directly (no LLM calls).
// ---------------------------------------------------------------------------

describe("Sprites agent I/O — end-to-end", { skip: !spritesToken }, () => {
	let provider: SpritesSandboxProvider
	let handle: SandboxHandle | undefined

	after(async () => {
		if (handle && provider) {
			try {
				await provider.destroy(handle)
			} catch {
				// Best-effort cleanup
			}
		}
	})

	it(
		"starts headless agent, sends command via stdin, receives NDJSON events on stdout",
		{ timeout: 180_000 },
		async () => {
			provider = new SpritesSandboxProvider({ token: spritesToken })

			// 1. Create sprite and set up env vars
			handle = await provider.create(SESSION_ID, {
				projectName: "test-io",
			})
			assert.ok(handle, "sprite handle should exist")

			const sprite = provider.getSpriteObject(SESSION_ID)
			assert.ok(sprite, "sprite object should exist")

			// 2. Verify env file was written correctly (tests the base64/execFile fix)
			const envCheck = await provider.exec(handle, "cat /etc/profile.d/electric-agent.sh")
			assert.ok(
				envCheck.includes("SANDBOX_MODE"),
				`env file should contain SANDBOX_MODE, got: ${envCheck}`,
			)

			// 3. Create a git repo in the project dir so the git command works
			await provider.exec(
				handle,
				`cd ${handle.projectDir} && git init && git config user.name "test" && git config user.email "test@test.com"`,
			)

			// 4. Instead of trying to use spawn/createSession with stdin/stdout
			// (which has WebSocket timing issues), use execFile to run the agent
			// with a pre-written config file piped via stdin.
			// This tests the full I/O pipeline: env setup → agent start → stdin
			// config → stdout NDJSON events.
			await sleep(1000)

			// Write the config command to a file so we can pipe it
			const config = {
				type: "command",
				command: "git",
				projectDir: handle.projectDir,
				gitOp: "commit",
				gitMessage: "test commit from sprites integration test",
			}
			const configJson = JSON.stringify(config)
			await sprite.execFile("bash", [
				"-c",
				`echo '${configJson.replaceAll("'", "'\\''")}' > /tmp/test-config.json`,
			])

			// 6. Run the headless agent with config piped via stdin, capture stdout
			const result = await sprite.execFile("bash", [
				"-c",
				"source /etc/profile.d/npm-global.sh 2>/dev/null; source /etc/profile.d/electric-agent.sh && cat /tmp/test-config.json | electric-agent headless 2>/tmp/agent-stderr.log",
			])

			const stdout =
				typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf-8")

			// Read stderr for diagnostics on failure
			let stderrContent = ""
			try {
				const stderrResult = await sprite.execFile("bash", [
					"-c",
					"cat /tmp/agent-stderr.log 2>/dev/null || echo ''",
				])
				stderrContent =
					typeof stderrResult.stdout === "string"
						? stderrResult.stdout
						: stderrResult.stdout.toString("utf-8")
			} catch {
				// Ignore stderr read failures
			}

			// 6. Parse NDJSON events from stdout
			const events = stdout
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => {
					try {
						return JSON.parse(line.trim()) as Record<string, unknown>
					} catch {
						return null
					}
				})
				.filter(Boolean) as Record<string, unknown>[]

			// 7. Validate we received meaningful NDJSON output
			assert.ok(
				events.length > 0,
				`should have received at least one event. stdout: ${stdout}\nstderr: ${stderrContent}`,
			)

			const sessionComplete = events.find((e) => e.type === "session_complete")
			assert.ok(sessionComplete, "should have received session_complete event")
			// Git commit with no changes still succeeds (emits "No changes to commit")
			assert.equal(sessionComplete?.success, true, "session should complete successfully")

			// Should have at least a tool_start or log event before session_complete
			const nonComplete = events.filter((e) => e.type !== "session_complete")
			assert.ok(
				nonComplete.length > 0,
				`should have events before session_complete, got: ${JSON.stringify(events)}`,
			)
		},
	)

	const SESSION_ID = `test-io-${Date.now().toString(36)}`
})
