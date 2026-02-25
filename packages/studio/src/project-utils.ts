import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

/**
 * Resolve a unique project directory name under `baseDir`.
 * If the directory already exists, appends a random 4-char hex suffix.
 */
export function resolveProjectDir(
	baseDir: string,
	name: string,
): { projectName: string; projectDir: string } {
	const candidate = path.resolve(baseDir, name)
	if (!fs.existsSync(candidate)) {
		return { projectName: name, projectDir: candidate }
	}
	const suffix = crypto.randomBytes(2).toString("hex")
	const uniqueName = `${name}-${suffix}`
	return { projectName: uniqueName, projectDir: path.resolve(baseDir, uniqueName) }
}
