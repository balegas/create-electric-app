import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const templateDir = path.resolve(__dirname, "../../template")

export interface ScaffoldResult {
	projectDir: string
	skippedInstall: boolean
	errors: string[]
}

/**
 * Scaffold a new Electric + TanStack DB project from the KPB template.
 *
 * 1. Clone KPB via `npx gitpick KyleAMathews/kpb`
 * 2. Copy Electric + Drizzle infrastructure files
 * 3. Merge dependencies into package.json
 * 4. Patch vite.config.ts, root route, .gitignore
 * 5. Set up .env and _agent/ directory
 * 6. Run pnpm install
 */
export async function scaffold(
	projectDir: string,
	opts?: { skipInstall?: boolean; projectName?: string },
): Promise<ScaffoldResult> {
	const errors: string[] = []
	let skippedInstall = opts?.skipInstall ?? false

	// Step 1: Clone KPB template
	if (!fs.existsSync(projectDir)) {
		fs.mkdirSync(projectDir, { recursive: true })
	}
	try {
		execSync(`npx gitpick KyleAMathews/kpb ${projectDir} -o`, {
			stdio: "pipe",
			timeout: 120_000,
		})
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "gitpick failed"
		throw new Error(`Failed to clone KPB template: ${msg}`)
	}

	// Step 2: Copy template overlay files
	copyTemplateFiles(templateDir, projectDir)

	// Step 3: Merge dependencies and rename project
	mergeDependencies(projectDir, opts?.projectName)

	// Step 4: Delete stale lockfile (we changed deps, lockfile is now invalid)
	const lockPath = path.join(projectDir, "pnpm-lock.yaml")
	if (fs.existsSync(lockPath)) {
		fs.unlinkSync(lockPath)
	}

	// Step 5: Patch vite.config.ts
	patchViteConfig(projectDir)

	// Step 6: Patch root route for shellComponent
	patchRootRoute(projectDir)

	// Step 6b: Fix public-dir CSS imports that break Rollup production builds
	patchPublicCssImports(projectDir)

	// Step 7: Copy .env.example -> .env
	const envExample = path.join(projectDir, ".env.example")
	const envFile = path.join(projectDir, ".env")
	if (fs.existsSync(envExample) && !fs.existsSync(envFile)) {
		fs.copyFileSync(envExample, envFile)
	}

	// Step 8: Create _agent/ working memory directory
	const agentDir = path.join(projectDir, "_agent")
	fs.mkdirSync(agentDir, { recursive: true })
	fs.writeFileSync(path.join(agentDir, "errors.md"), "# Error Log\n\n", "utf-8")
	fs.writeFileSync(path.join(agentDir, "session.md"), "# Session State\n\n", "utf-8")

	// Step 9: Patch .gitignore
	patchGitignore(projectDir)

	// Step 10: Install dependencies
	if (!skippedInstall) {
		try {
			const installer = detectPackageManager(projectDir)
			execSync(`${installer} install`, {
				cwd: projectDir,
				stdio: "pipe",
				timeout: 180_000,
			})
		} catch (e: unknown) {
			const stdout = (e as Record<string, Buffer | string>)?.stdout?.toString() || ""
			const stderr = (e as Record<string, Buffer | string>)?.stderr?.toString() || ""
			const combined = `${stdout}\n${stderr}`.trim()
			errors.push(`Package install failed: ${combined.slice(0, 500)}`)
			skippedInstall = true
		}
	}

	return { projectDir, skippedInstall, errors }
}

function detectPackageManager(projectDir: string): string {
	if (fs.existsSync(path.join(projectDir, "pnpm-lock.yaml"))) return "pnpm"
	if (fs.existsSync(path.join(projectDir, "yarn.lock"))) return "yarn"
	// Check if pnpm is available
	try {
		execSync("pnpm --version", { stdio: "pipe" })
		return "pnpm"
	} catch {
		return "npm"
	}
}

function copyTemplateFiles(srcDir: string, destDir: string): void {
	if (!fs.existsSync(srcDir)) return

	for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
		const srcPath = path.join(srcDir, entry.name)
		const destPath = path.join(destDir, entry.name)

		if (entry.isDirectory()) {
			fs.mkdirSync(destPath, { recursive: true })
			copyTemplateFiles(srcPath, destPath)
		} else {
			fs.mkdirSync(path.dirname(destPath), { recursive: true })
			fs.copyFileSync(srcPath, destPath)
		}
	}
}

const ADDED_DEPENDENCIES: Record<string, string> = {
	"@tanstack/db": "0.5.25",
	"@tanstack/react-db": "0.1.69",
	"@tanstack/electric-db-collection": "0.2.31",
	"@electric-sql/client": "1.5.1",
	"drizzle-orm": "0.45.1",
	"drizzle-zod": "^0.8.3",
	postgres: "^3.4",
	zod: "^3.24",
}

const ADDED_DEV_DEPENDENCIES: Record<string, string> = {
	"drizzle-kit": "0.31.9",
	"@tanstack/db-playbook": "0.0.1",
}

const ADDED_SCRIPTS: Record<string, string> = {
	generate: "drizzle-kit generate",
	migrate: "drizzle-kit migrate",
	"db:push": "drizzle-kit push",
}

function mergeDependencies(projectDir: string, projectName?: string): void {
	const pkgPath = path.join(projectDir, "package.json")
	if (!fs.existsSync(pkgPath)) return

	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))

	// Rename project
	if (projectName) {
		pkg.name = projectName
	}

	pkg.dependencies = { ...(pkg.dependencies || {}), ...ADDED_DEPENDENCIES }
	pkg.devDependencies = { ...(pkg.devDependencies || {}), ...ADDED_DEV_DEPENDENCIES }
	pkg.scripts = { ...(pkg.scripts || {}), ...ADDED_SCRIPTS }

	fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8")
}

function patchViteConfig(projectDir: string): void {
	const vitePath = path.join(projectDir, "vite.config.ts")
	if (!fs.existsSync(vitePath)) return

	let content = fs.readFileSync(vitePath, "utf-8")

	// Change port to 5174 so Caddy can proxy on 5173
	content = content.replace(/port:\s*5173/, "port: 5174")

	// Bind to all interfaces so Caddy in Docker can reach the dev server
	// via host.docker.internal
	if (!content.includes("host:")) {
		content = content.replace(/port:\s*5174,?/, "port: 5174,\n\t\thost: true,")
	}

	fs.writeFileSync(vitePath, content, "utf-8")
}

// NOTE: patchRootRoute intentionally does NOT add ssr: false to the root
// route. The root renders the HTML shell (<html>, <head>, <Scripts>).
// Disabling SSR there prevents the document from rendering — blank page.
// The coder agent adds ssr: false to individual leaf routes instead.
function patchRootRoute(_projectDir: string): void {
	// no-op — root route must always SSR
}

function patchPublicCssImports(projectDir: string): void {
	const rootPath = path.join(projectDir, "src/routes/__root.tsx")
	if (!fs.existsSync(rootPath)) return

	let content = fs.readFileSync(rootPath, "utf-8")

	// KPB imports typography.css from the public dir via a module import:
	//   import typographyCss from '/typography.css?url'
	// Rollup can't resolve absolute public-dir paths during production builds.
	// The capsizeRadixPlugin generates this file into public/ only when Vite
	// runs, so it may not exist yet at scaffold time.
	//
	// Fix: remove the module import and inline the public path as a string
	// literal. Vite serves public/ files at the root, so "/typography.css"
	// works in both dev and production.
	const hasTypographyImport =
		content.includes(`'/typography.css?url'`) || content.includes(`"/typography.css?url"`)

	if (hasTypographyImport) {
		// Remove the import statement
		content = content.replace(
			/import\s+typographyCss\s+from\s+['"]\/typography\.css\?url['"];?\s*\n/,
			"",
		)
		// Replace the variable reference with a string literal
		content = content.replace(/href:\s*typographyCss/g, 'href: "/typography.css"')
		fs.writeFileSync(rootPath, content, "utf-8")
	}
}

function patchGitignore(projectDir: string): void {
	const gitignorePath = path.join(projectDir, ".gitignore")
	let content = ""
	if (fs.existsSync(gitignorePath)) {
		content = fs.readFileSync(gitignorePath, "utf-8")
	}

	const additions: string[] = []
	if (!content.includes("_agent/")) additions.push("_agent/")
	if (!content.includes("drizzle/meta/")) additions.push("drizzle/meta/")
	if (!content.includes(".env")) additions.push(".env")

	if (additions.length > 0) {
		content += `\n# Electric Agent\n${additions.join("\n")}\n`
		fs.writeFileSync(gitignorePath, content, "utf-8")
	}
}
