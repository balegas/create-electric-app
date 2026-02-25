import fs from "node:fs"
import path from "node:path"

/** Walk up from cwd looking for a file by name, return its path or undefined */
export function findUp(name: string): string | undefined {
	let dir = process.cwd()
	while (true) {
		const candidate = path.join(dir, name)
		if (fs.existsSync(candidate)) return candidate
		const parent = path.dirname(dir)
		if (parent === dir) return undefined
		dir = parent
	}
}
