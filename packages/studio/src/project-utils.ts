import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

/**
 * Resolve a unique project directory name under `baseDir`.
 * Always appends a random 4-char hex suffix to avoid container/volume
 * collisions when Docker compose project names overlap across sessions.
 */
export function resolveProjectDir(
	baseDir: string,
	name: string,
): { projectName: string; projectDir: string } {
	const suffix = crypto.randomBytes(2).toString("hex")
	const uniqueName = `${name}-${suffix}`
	return { projectName: uniqueName, projectDir: path.resolve(baseDir, uniqueName) }
}
