import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { gitInit } from "../git/index.js"

/** Minimal progress reporter interface (formerly in progress/reporter.ts) */
interface ProgressReporter {
	log(level: string, message: string): void
	verboseMode?: boolean
}

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
	opts?: {
		skipInstall?: boolean
		skipGit?: boolean
		projectName?: string
		reporter?: ProgressReporter
	},
): Promise<ScaffoldResult> {
	const errors: string[] = []
	const reporter = opts?.reporter
	let skippedInstall = opts?.skipInstall ?? false

	// Step 1: Clone KPB template
	if (!fs.existsSync(projectDir)) {
		fs.mkdirSync(projectDir, { recursive: true })
	}
	try {
		reporter?.log("verbose", "Cloning KPB template via gitpick...")
		execSync(`npx gitpick KyleAMathews/kpb ${projectDir} -o`, {
			stdio: "pipe",
			timeout: 120_000,
		})
		reporter?.log("verbose", "KPB template cloned")
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : "gitpick failed"
		throw new Error(`Failed to clone KPB template: ${msg}`)
	}

	// Validate that gitpick actually produced a usable project
	const pkgJsonPath = path.join(projectDir, "package.json")
	if (!fs.existsSync(pkgJsonPath)) {
		throw new Error(
			`Scaffold failed: package.json not found in ${projectDir} after cloning KPB template. ` +
				"The template clone may have been incomplete.",
		)
	}

	// Step 2: Copy template overlay files
	reporter?.log("verbose", `Copying template overlay files from ${templateDir}...`)
	if (!fs.existsSync(templateDir)) {
		reporter?.log(
			"error",
			`Template directory not found at ${templateDir} — template overlay files (drizzle.config.ts, etc.) will be missing`,
		)
	}
	copyTemplateFiles(templateDir, projectDir)
	reporter?.log("verbose", "Template overlay complete")

	// Step 3: Merge dependencies and rename project
	reporter?.log("verbose", "Merging dependencies into package.json...")
	mergeDependencies(projectDir, opts?.projectName)

	// Step 4: Delete stale lockfile (we changed deps, lockfile is now invalid)
	const lockPath = path.join(projectDir, "pnpm-lock.yaml")
	if (fs.existsSync(lockPath)) {
		fs.unlinkSync(lockPath)
		reporter?.log("verbose", "Removed stale pnpm-lock.yaml")
	}

	// Step 5: Patch vite.config.ts
	reporter?.log("verbose", "Patching vite.config.ts...")
	patchViteConfig(projectDir)

	// Step 6: Patch root route for shellComponent
	patchRootRoute(projectDir)

	// Step 6b: Fix public-dir CSS imports that break Rollup production builds
	reporter?.log("verbose", "Patching public CSS imports...")
	patchPublicCssImports(projectDir)

	// Step 6c: Set Electric brand theme colors in __root.tsx
	reporter?.log("verbose", "Patching theme colors...")
	patchThemeColors(projectDir)

	// Step 7: Copy .env.example -> .env and ensure VITE_PORT is set
	const envExample = path.join(projectDir, ".env.example")
	const envFile = path.join(projectDir, ".env")
	if (fs.existsSync(envExample) && !fs.existsSync(envFile)) {
		fs.copyFileSync(envExample, envFile)
		reporter?.log("verbose", "Copied .env.example to .env")
	}
	// Ensure VITE_PORT is in .env (default 5174 for local Caddy mode)
	if (fs.existsSync(envFile)) {
		const envContent = fs.readFileSync(envFile, "utf-8")
		if (!envContent.includes("VITE_PORT")) {
			fs.appendFileSync(envFile, "\nVITE_PORT=5174\n")
		}
	}

	// Step 8: Create _agent/ working memory directory
	const agentDir = path.join(projectDir, "_agent")
	fs.mkdirSync(agentDir, { recursive: true })
	fs.writeFileSync(path.join(agentDir, "errors.md"), "# Error Log\n\n", "utf-8")
	fs.writeFileSync(path.join(agentDir, "session.md"), "# Session State\n\n", "utf-8")
	reporter?.log("verbose", "Created _agent/ working memory directory")

	// Step 9: Patch .gitignore
	patchGitignore(projectDir)

	// Step 10: Install dependencies
	// Use --ignore-workspace to ensure packages install into the project's own
	// node_modules, not a parent workspace. Generated apps are standalone.
	if (!skippedInstall) {
		try {
			const installer = detectPackageManager(projectDir)
			const ignoreWs = installer === "pnpm" ? " --ignore-workspace" : ""
			reporter?.log("verbose", `Running ${installer} install...`)
			execSync(`${installer} install${ignoreWs}`, {
				cwd: projectDir,
				stdio: "pipe",
				timeout: 180_000,
			})
			reporter?.log("verbose", "Dependencies installed successfully")
		} catch (e: unknown) {
			const stdout = (e as Record<string, Buffer | string>)?.stdout?.toString() || ""
			const stderr = (e as Record<string, Buffer | string>)?.stderr?.toString() || ""
			const combined = `${stdout}\n${stderr}`.trim()
			if (reporter?.verboseMode) {
				errors.push(`Package install failed:\n${combined}`)
			} else {
				errors.push(`Package install failed: ${combined.slice(0, 500)}`)
			}
			skippedInstall = true
		}
	}

	// Step 11: Initialize git repo with initial commit (unless skipped)
	if (!opts?.skipGit) {
		reporter?.log("build", "Initializing git repository...")
		try {
			const commitOutput = gitInit(projectDir, opts?.projectName)
			reporter?.log("done", `Git initialized: ${commitOutput}`)
		} catch (e) {
			const msg = `Git init failed: ${e instanceof Error ? e.message : "unknown"}`
			reporter?.log("error", msg)
			errors.push(msg)

			// Attempt bare git init as recovery — at minimum create the .git directory
			// so later git operations don't fail with "not a git repository"
			try {
				execSync("git init -b main", { cwd: projectDir, stdio: "pipe" })
				execSync('git config user.email "electric-agent@local"', {
					cwd: projectDir,
					stdio: "pipe",
				})
				execSync('git config user.name "Electric Agent"', {
					cwd: projectDir,
					stdio: "pipe",
				})
				reporter?.log("verbose", "Recovery: bare git init succeeded")
			} catch {
				errors.push("Recovery git init also failed — git operations will not work")
			}
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
	"@tanstack/db": "0.5.31",
	"@tanstack/react-db": "0.1.75",
	"@tanstack/electric-db-collection": "0.2.39",
	"@electric-sql/client": "1.5.12",
	"drizzle-orm": "0.45.1",
	"drizzle-zod": "^0.8.3",
	postgres: "^3.4",
	zod: "^3.24",
}

const ADDED_DEV_DEPENDENCIES: Record<string, string> = {
	"drizzle-kit": "0.31.9",
	vitest: "^3.0.0",
	// Playbook packages (@electric-sql/playbook, @tanstack/db-playbook)
	// come from the KPB template — don't duplicate here.
}

const ADDED_SCRIPTS: Record<string, string> = {
	generate: "drizzle-kit generate",
	migrate: "drizzle-kit migrate",
	"db:push": "drizzle-kit push",
	"dev:start": "nohup pnpm dev > /tmp/dev-server.log 2>&1 & echo $! > /tmp/dev-server.pid",
	"dev:stop": "kill $(cat /tmp/dev-server.pid 2>/dev/null) 2>/dev/null; rm -f /tmp/dev-server.pid",
	"dev:restart": "pnpm dev:stop && pnpm dev:start",
	test: "vitest run",
	"test:watch": "vitest",
	"test:integration": "vitest run tests/integration",
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

	// Make port configurable via VITE_PORT env var (default 5174 for Caddy local mode,
	// sandbox sets VITE_PORT=5173 so the Docker port binding works)
	content = content.replace(/port:\s*5173/, "port: parseInt(process.env.VITE_PORT || '5174')")

	// Bind to all interfaces so Caddy/Docker/Sprites can reach the dev server.
	// Insert host + allowedHosts + proxy together after port to keep them grouped.
	if (!content.includes("host:")) {
		content = content.replace(
			/port:\s*parseInt\(process\.env\.VITE_PORT \|\| '5174'\),?/,
			"port: parseInt(process.env.VITE_PORT || '5174'),\n\t\thost: true,",
		)
	}

	// Ensure allowedHosts is always present — Vite blocks requests from
	// Sprites hostnames (*.sprites.app) without it.
	// Must be boolean `true`, NOT the string "all" — Vite only accepts
	// `string[] | true` (see https://vite.dev/config/server-options).
	if (!content.includes("allowedHosts")) {
		if (content.match(/host:\s*/)) {
			content = content.replace(/(host:\s*[^,\n]+,?)/, "$1\n\t\tallowedHosts: true,")
		} else if (content.match(/server:\s*\{/)) {
			content = content.replace(/(server:\s*\{)/, "$1\n\t\tallowedHosts: true,")
		}
	}

	// Add proxy for Electric shape API — works with both Caddy (external) and
	// sandbox (no Caddy, Electric on localhost:3000) setups
	if (!content.includes("proxy:")) {
		const proxyBlock = [
			"\t\tproxy: {",
			"\t\t\t'/v1/shape': {",
			"\t\t\t\ttarget: process.env.ELECTRIC_URL || 'http://localhost:3000',",
			"\t\t\t\tchangeOrigin: true,",
			"\t\t\t},",
			"\t\t},",
		].join("\n")
		// Insert proxy after allowedHosts or host line
		if (content.includes("allowedHosts")) {
			content = content.replace(/(allowedHosts:\s*true,?)/, `$1\n${proxyBlock}`)
		} else {
			content = content.replace(/(host:\s*true,?)/, `$1\n${proxyBlock}`)
		}
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

function patchThemeColors(projectDir: string): void {
	const rootPath = path.join(projectDir, "src/routes/__root.tsx")
	if (!fs.existsSync(rootPath)) return

	let content = fs.readFileSync(rootPath, "utf-8")

	// Replace KPB default accentColor="blue" (or any other) with Electric brand violet
	// Also add grayColor, radius, and panelBackground if not present
	const themeRegex = /<Theme\b([^>]*)>/
	const match = content.match(themeRegex)
	if (match) {
		let attrs = match[1]

		// Replace or add accentColor
		if (attrs.includes("accentColor")) {
			attrs = attrs.replace(/accentColor="[^"]*"/, 'accentColor="violet"')
		} else {
			attrs += ' accentColor="violet"'
		}

		// Replace or add grayColor
		if (attrs.includes("grayColor")) {
			attrs = attrs.replace(/grayColor="[^"]*"/, 'grayColor="mauve"')
		} else {
			attrs += ' grayColor="mauve"'
		}

		// Replace or add radius
		if (attrs.includes("radius=")) {
			attrs = attrs.replace(/radius="[^"]*"/, 'radius="medium"')
		} else {
			attrs += ' radius="medium"'
		}

		// Replace or add panelBackground
		if (attrs.includes("panelBackground")) {
			attrs = attrs.replace(/panelBackground="[^"]*"/, 'panelBackground="translucent"')
		} else {
			attrs += ' panelBackground="translucent"'
		}

		content = content.replace(themeRegex, `<Theme${attrs}>`)
		fs.writeFileSync(rootPath, content, "utf-8")
	}

	// Add Electric brand CSS custom properties to styles.css if present
	const stylesPath = path.join(projectDir, "src/styles.css")
	if (fs.existsSync(stylesPath)) {
		let styles = fs.readFileSync(stylesPath, "utf-8")
		if (!styles.includes("--electric-brand")) {
			styles += `\n:root {\n  --electric-brand: #d0bcff;\n  --electric-teal: #00d2a0;\n}\n`
			fs.writeFileSync(stylesPath, styles, "utf-8")
		}
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
