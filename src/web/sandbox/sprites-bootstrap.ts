/**
 * Bootstrap logic for Sprites sandboxes.
 *
 * Sprites run Ubuntu 24.04 with Node.js pre-installed but no project tooling.
 * This module installs the required tools (pnpm, electric-agent) and creates
 * a checkpoint so subsequent sprites can restore instantly.
 */

import type { Sprite } from "@fly/sprites"

const CHECKPOINT_COMMENT = "bootstrapped"

/**
 * Bootstrap a sprite by installing required global tools.
 * This runs inside a freshly-created sprite that has Node.js but nothing else.
 */
export async function bootstrapSprite(sprite: Sprite): Promise<void> {
	console.log(`[sprites-bootstrap] Installing pnpm...`)
	await sprite.exec("npm install -g pnpm", { maxBuffer: 50 * 1024 * 1024 })

	console.log(`[sprites-bootstrap] Installing electric-agent...`)
	await sprite.exec("npm install -g electric-agent", {
		maxBuffer: 50 * 1024 * 1024,
	})

	// Create the workspace directory structure matching other runtimes
	await sprite.exec("mkdir -p /home/agent/workspace")

	// Configure git (needed for the git agent)
	await sprite.exec('git config --global user.name "electric-agent"')
	await sprite.exec('git config --global user.email "agent@electric-sql.com"')
	await sprite.exec("git config --global init.defaultBranch main")

	console.log(`[sprites-bootstrap] Bootstrap complete`)
}

/**
 * Ensure the sprite is bootstrapped. If a "bootstrapped" checkpoint exists,
 * restore from it. Otherwise, run the full bootstrap and create the checkpoint.
 */
export async function ensureBootstrapped(sprite: Sprite): Promise<void> {
	// Check for existing checkpoint
	try {
		const checkpoints = await sprite.listCheckpoints()
		const bootstrapped = checkpoints.find((cp) => cp.comment === CHECKPOINT_COMMENT)
		if (bootstrapped) {
			console.log(`[sprites-bootstrap] Restoring from checkpoint "${bootstrapped.id}"...`)
			const response = await sprite.restoreCheckpoint(bootstrapped.id)
			// Consume the NDJSON response stream to completion
			await consumeStream(response)
			console.log(`[sprites-bootstrap] Restored from checkpoint`)
			return
		}
	} catch {
		// No checkpoints yet — proceed with bootstrap
	}

	// Run full bootstrap
	await bootstrapSprite(sprite)

	// Create checkpoint for future reuse
	console.log(`[sprites-bootstrap] Creating checkpoint...`)
	try {
		const response = await sprite.createCheckpoint(CHECKPOINT_COMMENT)
		await consumeStream(response)
		console.log(`[sprites-bootstrap] Checkpoint created`)
	} catch (err) {
		// Non-fatal — next creation will just bootstrap again
		console.warn(`[sprites-bootstrap] Failed to create checkpoint:`, err)
	}
}

/** Consume a streaming Response body to completion */
async function consumeStream(response: Response): Promise<void> {
	if (!response.body) return
	const reader = response.body.getReader()
	try {
		while (true) {
			const { done } = await reader.read()
			if (done) break
		}
	} finally {
		reader.releaseLock()
	}
}
