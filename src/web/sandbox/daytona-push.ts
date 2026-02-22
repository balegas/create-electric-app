#!/usr/bin/env tsx
/**
 * CLI script to push the sandbox image to Daytona's transient registry
 * and create a snapshot.
 *
 * Usage:
 *   DAYTONA_API_KEY=... npm run push:sandbox:daytona
 *   DAYTONA_API_KEY=... SANDBOX_IMAGE=my-image npx tsx src/web/sandbox/daytona-push.ts
 */
import "dotenv/config"
import { Daytona } from "@daytonaio/sdk"
import { ensureSnapshot } from "./daytona-registry.js"

async function main() {
	const apiKey = process.env.DAYTONA_API_KEY
	if (!apiKey) {
		console.error("Error: DAYTONA_API_KEY environment variable is required.")
		process.exit(1)
	}

	const apiUrl = process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api"
	const target = process.env.DAYTONA_TARGET ?? "us"
	const localImage = process.env.SANDBOX_IMAGE || "electric-agent-sandbox"

	console.log(`Pushing sandbox image "${localImage}" to Daytona...`)
	console.log(`  API URL: ${apiUrl}`)
	console.log(`  Target:  ${target}`)
	console.log()

	const daytona = new Daytona({ apiKey, apiUrl, target })

	const snapshotName = await ensureSnapshot(daytona, {
		apiKey,
		apiUrl,
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
