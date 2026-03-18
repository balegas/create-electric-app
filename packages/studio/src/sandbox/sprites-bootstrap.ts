/**
 * Bootstrap logic for Sprites sandboxes.
 *
 * Sprites run Ubuntu 24.04 with Node.js pre-installed but no project tooling.
 * This module installs the required tools (pnpm, electric-agent) and creates
 * a checkpoint so subsequent sprites can restore instantly.
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Sprite } from "@fly/sprites"

// Use the agent package version since that's what gets installed in the sprite.
// The agent package isn't a dependency of studio, so resolve it via workspace path.
const __dirname = dirname(fileURLToPath(import.meta.url))
const agentPkgPath = resolve(__dirname, "../../../agent/package.json")
export const agentVersion: string = (
	JSON.parse(readFileSync(agentPkgPath, "utf-8")) as { version: string }
).version

const CHECKPOINT_COMMENT = `bootstrapped:${agentVersion}`

export interface BootstrapOptions {
	/** Custom package URL (e.g. pkg-pr-new preview) to install instead of the published electric-agent */
	packageUrl?: string
}

/**
 * Bootstrap a sprite by installing required global tools.
 * This runs inside a freshly-created sprite that has Node.js but nothing else.
 */
export async function bootstrapSprite(sprite: Sprite, opts?: BootstrapOptions): Promise<void> {
	const packageSpec = opts?.packageUrl ?? "@electric-agent/agent"

	console.log(`[sprites-bootstrap] Installing pnpm...`)
	await sprite.exec("npm install -g pnpm", { maxBuffer: 50 * 1024 * 1024 })

	console.log(`[sprites-bootstrap] Installing electric-agent from: ${packageSpec}`)
	await sprite.execFile("bash", [
		"-c",
		`source /etc/profile.d/npm-global.sh 2>/dev/null; npm install -g ${packageSpec}`,
	])

	// Install Claude Code CLI (for claude-code bridge mode)
	console.log(`[sprites-bootstrap] Installing Claude Code CLI...`)
	await sprite.execFile("bash", [
		"-c",
		"source /etc/profile.d/npm-global.sh 2>/dev/null; npm install -g @anthropic-ai/claude-code",
	])

	// Create the workspace directory structure matching other runtimes
	await sprite.exec("mkdir -p /home/agent/workspace")

	// Write a profile script that adds npm global bin and nvm paths to PATH.
	// Sprites use nvm-managed Node.js — the bin dir isn't in the default PATH
	// when running commands via sprite.execFile("bash", ["-c", ...]).
	await sprite.execFile("bash", [
		"-c",
		[
			// Source nvm if present (sets up node/npm/npx in PATH)
			'export NVM_DIR="/.sprite/languages/node/nvm"',
			'[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
			// Get the npm global bin path and write it to a profile script
			'NPM_BIN="$(npm config get prefix)/bin"',
			'echo "export PATH=\\"$NPM_BIN:\\$PATH\\"" > /etc/profile.d/npm-global.sh',
			// Also add nvm init to the profile so node/npm are always available
			'echo "export NVM_DIR=\\"/.sprite/languages/node/nvm\\"" >> /etc/profile.d/npm-global.sh',
			'echo "[ -s \\"\\$NVM_DIR/nvm.sh\\" ] && . \\"\\$NVM_DIR/nvm.sh\\"" >> /etc/profile.d/npm-global.sh',
		].join(" && "),
	])

	// Configure git (needed for the git agent)
	// Use execFile to avoid sprite.exec() splitting quoted args by whitespace
	await sprite.execFile("git", ["config", "--global", "user.name", "electric-agent"])
	await sprite.execFile("git", ["config", "--global", "user.email", "agent@electric-sql.com"])
	await sprite.execFile("git", ["config", "--global", "init.defaultBranch", "main"])

	// Configure gh as the git credential helper so `git push` authenticates
	// via GH_TOKEN. Without this, HTTPS pushes fail in the sandbox because
	// there's no interactive terminal for git to prompt for credentials.
	// Note: gh auth setup-git only writes the credential.helper config —
	// it doesn't need GH_TOKEN at this point. The token is read at push time.
	await sprite.execFile("git", [
		"config",
		"--global",
		"credential.helper",
		"!gh auth git-credential",
	])

	console.log(`[sprites-bootstrap] Bootstrap complete (electric-agent@${agentVersion})`)
}

/**
 * Ensure the sprite is bootstrapped. If a matching checkpoint exists,
 * restore from it. Otherwise, run the full bootstrap and create a checkpoint.
 *
 * When a custom packageUrl is provided (e.g. PR preview), the checkpoint
 * comment includes a hash of the URL so different versions don't collide.
 */
export async function ensureBootstrapped(sprite: Sprite, opts?: BootstrapOptions): Promise<void> {
	const comment = opts?.packageUrl
		? `${CHECKPOINT_COMMENT}:${shortHash(opts.packageUrl)}`
		: CHECKPOINT_COMMENT

	// Check for existing checkpoint
	try {
		const checkpoints = await sprite.listCheckpoints()
		const bootstrapped = checkpoints.find((cp) => cp.comment === comment)
		if (bootstrapped) {
			console.log(
				`[sprites-bootstrap] Restoring from checkpoint "${bootstrapped.id}" (electric-agent@${agentVersion})`,
			)
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
	await bootstrapSprite(sprite, opts)

	// Create checkpoint for future reuse
	console.log(`[sprites-bootstrap] Creating checkpoint...`)
	try {
		const response = await sprite.createCheckpoint(comment)
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

/** Simple string hash for checkpoint disambiguation */
function shortHash(input: string): string {
	let hash = 0
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0
	}
	return (hash >>> 0).toString(36)
}
