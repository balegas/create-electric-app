import { execFileSync, spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Registry } from "@electric-agent/studio/registry"
import type { SandboxProvider } from "@electric-agent/studio/sandbox"
import { DaytonaSandboxProvider } from "@electric-agent/studio/sandbox/daytona"
import { getSnapshotStatus } from "@electric-agent/studio/sandbox/daytona-registry"
import { DockerSandboxProvider } from "@electric-agent/studio/sandbox/docker"
import { SpritesSandboxProvider } from "@electric-agent/studio/sandbox/sprites"
import { startWebServer } from "@electric-agent/studio/server"
import { getStreamConfig } from "@electric-agent/studio/streams"
import { inferProjectName } from "../agents/clarifier.js"

export async function serveCommand(opts: {
	port?: number
	dataDir?: string
	open?: boolean
}): Promise<void> {
	const port = opts.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 4400)
	const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? ".electric-agent"

	// Require hosted stream credentials
	const streamConfig = getStreamConfig()
	if (!streamConfig) {
		console.error("Error: DS_URL, DS_SERVICE_ID, and DS_SECRET environment variables are required.")
		console.error("Set these to connect to the hosted Durable Streams service.")
		process.exit(1)
	}

	// Select sandbox provider:
	//   SANDBOX_RUNTIME=docker  → always Docker
	//   SANDBOX_RUNTIME=daytona → always Daytona
	//   (unset)                 → Daytona if DAYTONA_API_KEY is set, otherwise Docker
	const runtime = process.env.SANDBOX_RUNTIME?.toLowerCase()
	let sandbox: SandboxProvider
	if (runtime === "docker") {
		sandbox = new DockerSandboxProvider()
		console.log("[serve] Sandbox runtime: Docker (SANDBOX_RUNTIME=docker)")
	} else if (runtime === "daytona" || (!runtime && process.env.DAYTONA_API_KEY)) {
		if (!process.env.DAYTONA_API_KEY) {
			console.error("Error: SANDBOX_RUNTIME=daytona requires DAYTONA_API_KEY to be set.")
			process.exit(1)
		}
		sandbox = new DaytonaSandboxProvider({
			apiKey: process.env.DAYTONA_API_KEY,
			apiUrl: process.env.DAYTONA_API_URL,
			target: process.env.DAYTONA_TARGET,
		})
		console.log(`[serve] Sandbox runtime: Daytona (target: ${process.env.DAYTONA_TARGET ?? "eu"})`)

		// Check snapshot status (non-blocking)
		const { Daytona } = await import("@daytonaio/sdk")
		const daytona = new Daytona({
			apiKey: process.env.DAYTONA_API_KEY,
			apiUrl: process.env.DAYTONA_API_URL,
			target: process.env.DAYTONA_TARGET ?? "eu",
		})
		const snapshotImage = process.env.SANDBOX_IMAGE || "electric-agent-sandbox"
		const status = await getSnapshotStatus(daytona, snapshotImage)
		if (status.exists) {
			console.log(`[serve] Snapshot "${snapshotImage}": ${status.state}`)
		} else {
			console.log(
				`[serve] Snapshot "${snapshotImage}" not found — will be created on first sandbox creation`,
			)
			console.log(`[serve] To pre-push: npm run push:sandbox:daytona`)
		}
	} else if (runtime === "sprites" || (!runtime && process.env.FLY_API_TOKEN)) {
		if (!process.env.FLY_API_TOKEN) {
			console.error("Error: SANDBOX_RUNTIME=sprites requires FLY_API_TOKEN to be set.")
			process.exit(1)
		}
		sandbox = new SpritesSandboxProvider({
			token: process.env.FLY_API_TOKEN,
		})
		console.log(`[serve] Sandbox runtime: Sprites (Fly.io)`)
	} else {
		sandbox = new DockerSandboxProvider()
		console.log("[serve] Sandbox runtime: Docker (default)")
	}

	// Determine bridge mode:
	//   BRIDGE_MODE=stdio       → always stdin/stdout (required for Daytona without internet)
	//   BRIDGE_MODE=stream      → always hosted Durable Streams (default for Docker & Sprites)
	//   BRIDGE_MODE=claude-code → Claude Code CLI in sandbox with stream-json I/O
	//   (unset)                 → "stdio" for Daytona, "stream" for Docker/Sprites
	const bridgeModeEnv = process.env.BRIDGE_MODE?.toLowerCase()
	let bridgeMode: "stream" | "stdio" | "claude-code"
	if (bridgeModeEnv === "claude-code") {
		bridgeMode = "claude-code"
	} else if (bridgeModeEnv === "stdio") {
		bridgeMode = "stdio"
	} else if (bridgeModeEnv === "stream") {
		bridgeMode = "stream"
	} else {
		// Default: Daytona uses stdio (required — no internet), others use stream
		bridgeMode = sandbox.runtime === "daytona" ? "stdio" : "stream"
	}
	console.log(`[serve] Bridge mode: ${bridgeMode}`)

	// Create registry (hydrates from durable stream)
	console.log("[serve] Hydrating registry from durable stream...")
	const registry = await Registry.create(streamConfig)

	await startWebServer({
		port,
		dataDir,
		registry,
		sandbox,
		streamConfig,
		bridgeMode,
		inferProjectName,
	})

	console.log(`\nWeb UI ready at http://127.0.0.1:${port}`)

	// Start Caddy reverse proxy for HTTP/2 (required for concurrent SSE streams)
	let caddyProcess: ReturnType<typeof spawn> | null = null
	const caddyPort = 4443
	try {
		execFileSync("caddy", ["version"], { stdio: "ignore" })
		// Resolve Caddyfile: agent dist is at packages/agent/dist/cli/serve.js
		// Caddyfile is at packages/studio/Caddyfile
		const thisDir = path.dirname(fileURLToPath(import.meta.url))
		const caddyfile = path.resolve(thisDir, "../../../studio/Caddyfile")
		caddyProcess = spawn("caddy", ["run", "--config", caddyfile], {
			stdio: ["ignore", "pipe", "pipe"],
		})
		caddyProcess.stderr?.on("data", (chunk: Buffer) => {
			const line = chunk.toString().trim()
			if (line) console.log(`[caddy] ${line}`)
		})
		caddyProcess.on("error", (err) => {
			console.warn(`[caddy] Failed to start: ${err.message}`)
			caddyProcess = null
		})
		caddyProcess.on("exit", (code) => {
			if (code !== null && code !== 0) {
				console.warn(`[caddy] Exited with code ${code}`)
			}
			caddyProcess = null
		})
		console.log(`  → HTTPS (HTTP/2): https://localhost:${caddyPort}`)
	} catch {
		console.log(
			`  → Install Caddy for HTTP/2 support (required for concurrent SSE): brew install caddy`,
		)
	}

	const publicUrl = caddyProcess ? `https://localhost:${caddyPort}` : `http://127.0.0.1:${port}`

	if (opts.open) {
		const { exec } = await import("node:child_process")
		const platform = process.platform
		const cmd =
			platform === "darwin"
				? `open ${publicUrl}`
				: platform === "win32"
					? `start ${publicUrl}`
					: `xdg-open ${publicUrl}`
		exec(cmd)
	}

	// Graceful shutdown — kill Caddy, force exit on second Ctrl+C
	let shuttingDown = false
	const shutdown = async () => {
		if (shuttingDown) {
			process.exit(1)
		}
		shuttingDown = true
		console.log("\nShutting down...")
		if (caddyProcess) {
			caddyProcess.kill("SIGTERM")
		}
		process.exit(0)
	}
	process.on("SIGINT", shutdown)
	process.on("SIGTERM", shutdown)
}
