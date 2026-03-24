/**
 * `electric-agent create "Build a todo app"`
 *
 * Headless mode: starts the server (or connects to an existing one),
 * creates a room with agents, auto-provisions infrastructure,
 * prints join info, and waits. Cleans up on Ctrl+C.
 */

import { ElectricAgentClient } from "@electric-agent/protocol/client"

export async function createCommand(
	description: string,
	opts: { port?: number; serverUrl?: string; local?: boolean },
) {
	const port = opts.port ?? 4400
	const serverUrl = opts.serverUrl ?? `http://127.0.0.1:${port}`

	const client = new ElectricAgentClient({
		baseUrl: `${serverUrl}/api`,
		credentials: () => ({}),
	})

	// Verify connection
	try {
		await client.getConfig()
	} catch {
		console.error(`Cannot connect to server at ${serverUrl}`)
		process.exit(1)
	}

	console.log()
	console.log(`Creating: "${description}"`)
	console.log()

	let roomId: string | undefined
	const sessionIds: string[] = []

	async function cleanup() {
		console.log()
		console.log("Shutting down...")
		if (roomId) {
			try {
				await client.closeAgentRoom(roomId)
			} catch {
				/* ignore */
			}
		}
		for (const sid of sessionIds) {
			try {
				await client.deleteSession(sid)
			} catch {
				/* ignore */
			}
		}
		console.log("Done.")
		process.exit(0)
	}

	process.on("SIGINT", () => {
		cleanup()
	})
	process.on("SIGTERM", () => {
		cleanup()
	})

	try {
		const result = await client.createAppRoom(description)
		roomId = result.roomId
		for (const s of result.sessions) {
			sessionIds.push(s.sessionId)
		}

		console.log(`Room: ${result.name}`)
		console.log(`Agents: ${result.sessions.map((s) => `${s.name} (${s.role})`).join(", ")}`)
		console.log()

		// Auto-provision infrastructure
		const coderSession = result.sessions.find((s) => s.role === "coder")
		if (coderSession) {
			if (opts.local) {
				console.log("Using local Docker for database and Electric...")
				try {
					await client.respondToGate(coderSession.sessionId, "infra_config", {
						mode: "local",
					})
					console.log("Local Docker infrastructure configured")
				} catch {
					console.error("Failed to configure infrastructure")
					await cleanup()
				}
			} else {
				console.log("Provisioning Electric Cloud...")
				try {
					const provision = await client.provisionElectric()
					await client.respondToGate(coderSession.sessionId, "infra_config", {
						mode: "claim",
						databaseUrl: provision.databaseUrl,
						electricUrl: provision.electricUrl,
						sourceId: provision.sourceId,
						secret: provision.secret,
						claimId: provision.claimId,
					})
					console.log(`Electric Cloud provisioned (72h TTL)`)
					console.log(`Claim: ${provision.claimUrl}`)
				} catch {
					console.log("Cloud unavailable, falling back to local Docker...")
					try {
						await client.respondToGate(coderSession.sessionId, "infra_config", {
							mode: "local",
						})
						console.log("Local Docker infrastructure configured")
					} catch {
						console.error("Failed to configure infrastructure")
						await cleanup()
					}
				}
			}
		}

		console.log()
		console.log(`Open: ${serverUrl}/room/${roomId}?code=${result.code}`)
		console.log()
		console.log("Press Ctrl+C to stop.")

		// Wait forever
		await new Promise(() => {})
	} catch (err) {
		console.error("Failed:", err instanceof Error ? err.message : err)
		await cleanup()
	}
}
