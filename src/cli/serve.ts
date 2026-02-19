import { startStreamServer, stopStreamServer } from "../web/infra.js"
import { startWebServer } from "../web/server.js"

export async function serveCommand(opts: {
	port?: number
	streamsPort?: number
	dataDir?: string
	open?: boolean
	sandbox?: boolean
}): Promise<void> {
	const port = opts.port ?? 4400
	const streamsPort = opts.streamsPort ?? 4437
	const dataDir = opts.dataDir ?? ".electric-agent"
	const sandbox = opts.sandbox ?? false

	// Start durable streams server
	await startStreamServer({ port: streamsPort, dataDir })

	// Start web API + static file server
	await startWebServer({ port, streamsPort, dataDir, sandbox })

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
		try {
			await stopStreamServer()
		} catch {
			// Best-effort cleanup
		}
		process.exit(0)
	}
	process.on("SIGINT", shutdown)
	process.on("SIGTERM", shutdown)
}
