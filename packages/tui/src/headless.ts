/**
 * Headless mode: create a room, print join info, wait for Ctrl+C, clean up.
 *
 * Usage: electric-tui --one-line "Build a todo app"
 */

import { ElectricAgentClient } from "@electric-agent/protocol/client"
import type { TuiConfig } from "./lib/config.js"
import { tokenStore } from "./lib/token-store.js"

export async function runHeadless(description: string, baseUrl: string, config: TuiConfig) {
	const client = new ElectricAgentClient({
		baseUrl: `${baseUrl}/api`,
		credentials: () => ({
			apiKey: config.credentials.apiKey,
			oauthToken: config.credentials.oauthToken,
			ghToken: config.credentials.githubToken,
		}),
		participant: () => config.participant,
		tokenStore,
	})

	// Verify server connection
	try {
		await client.getConfig()
	} catch {
		console.error(`Cannot connect to server at ${baseUrl}`)
		process.exit(1)
	}

	console.log(`Creating room for: "${description}"`)
	console.log()

	let roomId: string | undefined
	const sessionIds: string[] = []

	// Clean up on exit
	async function cleanup() {
		console.log()
		console.log("Shutting down...")
		if (roomId) {
			try {
				await client.closeAgentRoom(roomId)
			} catch { /* ignore */ }
		}
		for (const sid of sessionIds) {
			try {
				await client.deleteSession(sid)
			} catch { /* ignore */ }
		}
		console.log("Done.")
		process.exit(0)
	}

	process.on("SIGINT", () => { cleanup() })
	process.on("SIGTERM", () => { cleanup() })

	try {
		// Create the room
		const result = await client.createAppRoom(description)
		roomId = result.roomId
		for (const s of result.sessions) {
			sessionIds.push(s.sessionId)
		}

		console.log(`Room created: ${result.name}`)
		console.log(`Join code: ${result.roomId}/${result.code}`)
		console.log(`Agents: ${result.sessions.map((s) => `${s.name} (${s.role})`).join(", ")}`)
		console.log()

		// Auto-respond to infra gate with cloud provisioning
		const coderSession = result.sessions.find((s) => s.role === "coder")
		if (coderSession) {
			console.log("Provisioning Electric Cloud infrastructure...")
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
				console.log(`Infrastructure provisioned (72h TTL)`)
				console.log(`Claim: ${provision.claimUrl}`)
			} catch (err) {
				// Fall back to local Docker
				console.log("Cloud provisioning unavailable, using local Docker...")
				try {
					await client.respondToGate(coderSession.sessionId, "infra_config", {
						mode: "local",
					})
					console.log("Using local Docker infrastructure")
				} catch {
					console.error("Failed to configure infrastructure")
					await cleanup()
				}
			}
		}

		console.log()
		console.log("App is being created. Open the web UI or join the room to observe.")
		console.log(`Web UI: ${baseUrl}/room/${roomId}`)
		console.log()
		console.log("Press Ctrl+C to stop and clean up.")

		// Wait forever
		await new Promise(() => {})
	} catch (err) {
		console.error("Failed to create room:", err instanceof Error ? err.message : err)
		await cleanup()
	}
}
