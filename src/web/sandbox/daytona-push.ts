#!/usr/bin/env tsx
/**
 * CLI script to build a linux/amd64 sandbox image, push it to Daytona's
 * transient registry, and create a snapshot.
 *
 * Required env vars:
 *   DAYTONA_API_KEY — Daytona API key
 *
 * Optional:
 *   DAYTONA_API_URL  — Daytona API URL (default: https://app.daytona.io/api)
 *   DAYTONA_TARGET   — Daytona target region (default: eu)
 *   SANDBOX_IMAGE    — Local image name (default: electric-agent-sandbox)
 *
 * Usage:
 *   npm run push:sandbox:daytona
 */
import { execSync } from "node:child_process"
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
	const target = process.env.DAYTONA_TARGET ?? "eu"
	const localImage = process.env.SANDBOX_IMAGE || "electric-agent-sandbox"

	// Build linux/amd64 image (Daytona requires x86)
	console.log(`Building ${localImage} for linux/amd64...`)
	execSync(`docker build --platform linux/amd64 -f Dockerfile.sandbox -t ${localImage} .`, {
		stdio: "inherit",
		timeout: 600_000,
	})
	console.log()

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
