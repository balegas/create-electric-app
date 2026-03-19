/**
 * CLI script to pre-create a sprite checkpoint for the current agent version.
 *
 * Run after publishing / deploying so the first sprite creation in prod
 * restores from checkpoint instantly instead of running a full bootstrap.
 *
 * Usage:
 *   SPRITES_API_TOKEN=... npx tsx packages/studio/src/sandbox/create-checkpoint.ts
 */

import { SpritesClient } from "@fly/sprites"
import { agentVersion, bootstrapSprite } from "./sprites-bootstrap.js"

const SPRITE_NAME = "ea-checkpoint-builder"

async function main() {
	const token = process.env.SPRITES_API_TOKEN || process.env.FLY_API_TOKEN
	if (!token) {
		console.error("SPRITES_API_TOKEN (or FLY_API_TOKEN) is required")
		process.exit(1)
	}

	const comment = `bootstrapped:${agentVersion}`

	const client = new SpritesClient(token)

	// Check if checkpoint already exists (using any sprite)
	console.log(`Checking for existing checkpoint: "${comment}"`)
	const tempSprite = await client.createSprite(SPRITE_NAME, {
		ramMB: 2048,
		cpus: 2,
		region: "ord",
	})

	try {
		const checkpoints = await tempSprite.listCheckpoints()
		const existing = checkpoints.find((cp) => cp.comment === comment)
		if (existing) {
			console.log(`Checkpoint already exists: ${existing.id}`)
			await tempSprite.delete()
			return
		}

		// Run full bootstrap
		console.log(`No checkpoint for version ${agentVersion}, running bootstrap...`)
		await bootstrapSprite(tempSprite)

		// Create checkpoint
		console.log(`Creating checkpoint "${comment}"...`)
		const stream = await tempSprite.createCheckpoint(comment)
		await stream.processAll(() => {})
		console.log(`Checkpoint created successfully`)
	} finally {
		// Clean up
		try {
			await tempSprite.delete()
			console.log(`Temporary sprite deleted`)
		} catch {
			console.warn(`Failed to delete temporary sprite ${SPRITE_NAME}`)
		}
	}
}

main().catch((err) => {
	console.error("Failed to create checkpoint:", err)
	process.exit(1)
})
