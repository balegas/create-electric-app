#!/usr/bin/env tsx
/**
 * CLI script to push the sandbox image to Docker Hub, register the
 * registry in Daytona, and create a snapshot.
 *
 * Required env vars:
 *   DAYTONA_API_KEY    — Daytona API key
 *   DOCKER_HUB_USER   — Docker Hub username
 *   DOCKER_HUB_TOKEN  — Docker Hub personal access token (read+write)
 *
 * Optional:
 *   DAYTONA_API_URL    — Daytona API URL (default: https://app.daytona.io/api)
 *   DAYTONA_TARGET     — Daytona target region (default: us)
 *   SANDBOX_IMAGE      — Local image name (default: electric-agent-sandbox)
 *
 * Usage:
 *   npm run push:sandbox:daytona
 */
import "dotenv/config"
import { Daytona } from "@daytonaio/sdk"
import { ensureSnapshot } from "./daytona-registry.js"

async function main() {
	const daytonaApiKey = process.env.DAYTONA_API_KEY
	const dockerHubUser = process.env.DOCKER_HUB_USER
	const dockerHubToken = process.env.DOCKER_HUB_TOKEN

	if (!daytonaApiKey) {
		console.error("Error: DAYTONA_API_KEY environment variable is required.")
		process.exit(1)
	}
	if (!dockerHubUser || !dockerHubToken) {
		console.error("Error: DOCKER_HUB_USER and DOCKER_HUB_TOKEN environment variables are required.")
		console.error("")
		console.error("To set up Docker Hub:")
		console.error("  1. Create an account at https://hub.docker.com/signup")
		console.error("  2. Create a PAT at https://hub.docker.com/settings/security (Read & Write)")
		console.error("  3. export DOCKER_HUB_USER=your-username")
		console.error("  4. export DOCKER_HUB_TOKEN=dckr_pat_...")
		process.exit(1)
	}

	const daytonaApiUrl = process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api"
	const target = process.env.DAYTONA_TARGET ?? "us"
	const localImage = process.env.SANDBOX_IMAGE || "electric-agent-sandbox"

	console.log(
		`Pushing sandbox image "${localImage}" to Docker Hub and creating Daytona snapshot...`,
	)
	console.log(`  Docker Hub: ${dockerHubUser}/${localImage}`)
	console.log(`  Daytona:    ${daytonaApiUrl} (target: ${target})`)
	console.log()

	const daytona = new Daytona({ apiKey: daytonaApiKey, apiUrl: daytonaApiUrl, target })

	const snapshotName = await ensureSnapshot(daytona, {
		daytonaApiKey,
		daytonaApiUrl,
		dockerHubUser,
		dockerHubToken,
		localImage,
	})

	console.log()
	console.log(`Snapshot ready: "${snapshotName}"`)
	console.log("Sandboxes will now use this snapshot automatically.")

	process.exit(0)
}

main().catch((err) => {
	console.error("Failed to push sandbox image:", err)
	process.exit(1)
})
