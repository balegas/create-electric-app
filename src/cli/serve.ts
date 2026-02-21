import { DockerSandboxProvider } from "../web/sandbox/index.js"
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

	// Start web API + static file server with Docker sandbox
	const sandbox = new DockerSandboxProvider()
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
