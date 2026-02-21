import { DaytonaSandboxProvider } from "../web/sandbox/daytona.js"
import { DockerSandboxProvider } from "../web/sandbox/docker.js"
import type { SandboxProvider } from "../web/sandbox/types.js"
import { startWebServer } from "../web/server.js"
import { getStreamConfig } from "../web/streams.js"

export async function serveCommand(opts: {
	port?: number
	dataDir?: string
	open?: boolean
}): Promise<void> {
	const port = opts.port ?? 4400
	const dataDir = opts.dataDir ?? ".electric-agent"

	// Require hosted stream credentials
	const streamConfig = getStreamConfig()
	if (!streamConfig) {
		console.error("Error: DS_URL, DS_SERVICE_ID, and DS_SECRET environment variables are required.")
		console.error("Set these to connect to the hosted Durable Streams service.")
		process.exit(1)
	}

	// Select sandbox provider: Daytona (cloud) if API key is set, otherwise Docker (local)
	let sandbox: SandboxProvider
	if (process.env.DAYTONA_API_KEY) {
		sandbox = new DaytonaSandboxProvider({
			apiKey: process.env.DAYTONA_API_KEY,
			apiUrl: process.env.DAYTONA_API_URL,
			target: process.env.DAYTONA_TARGET,
		})
		console.log("Using Daytona cloud sandboxes")
	} else {
		sandbox = new DockerSandboxProvider()
		console.log("Using Docker local sandboxes")
	}

	await startWebServer({ port, dataDir, sandbox, streamConfig })

	console.log(`\nWeb UI ready at http://127.0.0.1:${port}`)

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
