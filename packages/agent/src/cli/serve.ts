import { execFileSync, spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { RoomRegistry } from "@electric-agent/studio/room-registry"
import type { SandboxProvider } from "@electric-agent/studio/sandbox"
import { DockerSandboxProvider } from "@electric-agent/studio/sandbox/docker"
import { SpritesSandboxProvider } from "@electric-agent/studio/sandbox/sprites"
import { startWebServer } from "@electric-agent/studio/server"
import { getStreamConfig } from "@electric-agent/studio/streams"

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
	//   SANDBOX_RUNTIME=sprites → always Sprites
	//   (unset)                 → Sprites if FLY_API_TOKEN is set, otherwise Docker
	const runtime = process.env.SANDBOX_RUNTIME?.toLowerCase()
	let sandbox: SandboxProvider
	if (runtime === "docker") {
		sandbox = new DockerSandboxProvider()
		console.log("[serve] Sandbox runtime: Docker (SANDBOX_RUNTIME=docker)")
	} else if (
		runtime === "sprites" ||
		(!runtime && (process.env.SPRITES_API_TOKEN || process.env.FLY_API_TOKEN))
	) {
		const spritesToken = process.env.SPRITES_API_TOKEN || process.env.FLY_API_TOKEN
		if (!spritesToken) {
			console.error(
				"Error: SANDBOX_RUNTIME=sprites requires SPRITES_API_TOKEN (or FLY_API_TOKEN) to be set.",
			)
			process.exit(1)
		}
		sandbox = new SpritesSandboxProvider({
			token: spritesToken,
		})
		console.log(`[serve] Sandbox runtime: Sprites (Fly.io)`)
	} else {
		sandbox = new DockerSandboxProvider()
		console.log("[serve] Sandbox runtime: Docker (default)")
	}

	console.log(`[serve] Bridge mode: claude-code`)

	// Create room registry (hydrates from durable stream)
	console.log("[serve] Hydrating room registry from durable stream...")
	const rooms = await RoomRegistry.create(streamConfig)

	await startWebServer({
		port,
		dataDir,
		rooms,
		sandbox,
		streamConfig,
		bridgeMode: "claude-code",
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
