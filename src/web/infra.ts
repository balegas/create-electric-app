import fs from "node:fs"
import path from "node:path"
import { DurableStreamTestServer } from "@durable-streams/server"

let serverInstance: DurableStreamTestServer | null = null

export async function startStreamServer(opts: {
	port?: number
	dataDir?: string
}): Promise<DurableStreamTestServer> {
	const port = opts.port ?? 4437
	const dataDir = opts.dataDir ? path.resolve(opts.dataDir, "streams") : undefined

	if (dataDir) {
		fs.mkdirSync(dataDir, { recursive: true })
	}

	const server = new DurableStreamTestServer({
		port,
		host: "127.0.0.1",
		...(dataDir ? { dataDir } : {}),
	})

	const url = await server.start()
	console.log(`Durable Streams server running at ${url}`)
	serverInstance = server
	return server
}

export async function stopStreamServer(): Promise<void> {
	if (serverInstance) {
		await serverInstance.stop()
		serverInstance = null
	}
}

export function getStreamServerUrl(port?: number): string {
	return `http://127.0.0.1:${port ?? 4437}`
}
