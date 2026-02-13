import { startStreamServer, stopStreamServer } from "../web/infra.js"
import { startWebServer } from "../web/server.js"

export async function serveCommand(opts: {
	port?: number
	streamsPort?: number
	dataDir?: string
	open?: boolean
}): Promise<void> {
	const port = opts.port ?? 4400
	const streamsPort = opts.streamsPort ?? 4437
	const dataDir = opts.dataDir ?? ".electric-agent"

	// Start durable streams server
	await startStreamServer({ port: streamsPort, dataDir })

	// Start web API + static file server
	await startWebServer({ port, streamsPort, dataDir })

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

	// Keep process alive
	process.on("SIGINT", async () => {
		console.log("\nShutting down...")
		await stopStreamServer()
		process.exit(0)
	})

	process.on("SIGTERM", async () => {
		await stopStreamServer()
		process.exit(0)
	})
}
