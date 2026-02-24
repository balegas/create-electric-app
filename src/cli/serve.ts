import { createRequire } from "node:module"
import { DaytonaSandboxProvider } from "../web/sandbox/daytona.js"
import { getSnapshotStatus } from "../web/sandbox/daytona-registry.js"
import { DockerSandboxProvider } from "../web/sandbox/docker.js"
import { SpritesSandboxProvider } from "../web/sandbox/sprites.js"
import type { SandboxProvider } from "../web/sandbox/types.js"
import { startWebServer } from "../web/server.js"
import { getStreamConfig } from "../web/streams.js"

const require = createRequire(import.meta.url)
const { version } = require("../../package.json") as { version: string }

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
	//   BRIDGE_MODE=stdio  → always stdin/stdout (required for Daytona without internet)
	//   BRIDGE_MODE=stream → always hosted Durable Streams (default for Docker & Sprites)
	//   (unset)            → "stdio" for Daytona, "stream" for Docker/Sprites
	const bridgeModeEnv = process.env.BRIDGE_MODE?.toLowerCase()
	let bridgeMode: "stream" | "stdio"
	if (bridgeModeEnv === "stdio") {
		bridgeMode = "stdio"
	} else if (bridgeModeEnv === "stream") {
		bridgeMode = "stream"
	} else {
		// Default: Daytona uses stdio (required — no internet), others use stream
		bridgeMode = sandbox.runtime === "daytona" ? "stdio" : "stream"
	}
	console.log(`[serve] Bridge mode: ${bridgeMode}`)

	await startWebServer({ port, dataDir, sandbox, streamConfig, bridgeMode })

	console.log(`\nelectric-agent@${version} — Web UI ready at http://127.0.0.1:${port}`)

	if (opts.open) {
		const { exec } = await import("node:child_process")
		const url = `http://127.0.0.1:${port}`
		const platform = process.platform
		const cmd =
			platform === "darwin"
				? `open ${url}`
				: platform === "win32"
					? `start ${url}`
					: `xdg-open ${url}`
		exec(cmd)
	}

	// Graceful shutdown — force exit on second Ctrl+C
	let shuttingDown = false
	const shutdown = async () => {
		if (shuttingDown) {
			process.exit(1)
		}
		shuttingDown = true
		console.log("\nShutting down...")
		process.exit(0)
	}
	process.on("SIGINT", shutdown)
	process.on("SIGTERM", shutdown)
}
