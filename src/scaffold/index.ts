import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const templateDir = path.resolve(__dirname, "../../template")

/**
 * Scaffold a new Electric + TanStack DB project from the KPB template.
 *
 * 1. Clone KPB via `npx gitpick KyleAMathews/kpb`
 * 2. Copy Electric + Drizzle infrastructure files
 * 3. Merge dependencies into package.json
 * 4. Modify vite.config.ts to add nitro plugin
 * 5. Set up .env and _agent/ directory
 * 6. Run pnpm install
 */
export async function scaffold(projectDir: string): Promise<void> {
	// Step 1: Clone KPB template
	if (!fs.existsSync(projectDir)) {
		fs.mkdirSync(projectDir, { recursive: true })
	}
	execSync(`npx gitpick KyleAMathews/kpb ${projectDir}`, {
		stdio: "pipe",
		timeout: 120_000,
	})

	// Step 2: Copy template files
	copyTemplateFiles(templateDir, projectDir)

	// Step 3: Merge dependencies
	mergeDependencies(projectDir)

	// Step 4: Modify vite.config.ts
	patchViteConfig(projectDir)

	// Step 5: Modify __root.tsx for shellComponent
	patchRootRoute(projectDir)

	// Step 6: Copy .env.example → .env
	const envExample = path.join(projectDir, ".env.example")
	const envFile = path.join(projectDir, ".env")
	if (fs.existsSync(envExample) && !fs.existsSync(envFile)) {
		fs.copyFileSync(envExample, envFile)
	}

	// Step 7: Create _agent/ directory
	const agentDir = path.join(projectDir, "_agent")
	fs.mkdirSync(agentDir, { recursive: true })
	fs.writeFileSync(path.join(agentDir, "errors.md"), "# Error Log\n\n", "utf-8")
	fs.writeFileSync(path.join(agentDir, "session.md"), "# Session State\n\n", "utf-8")

	// Step 8: Update .gitignore
	patchGitignore(projectDir)

	// Step 9: Install dependencies
	execSync("pnpm install", { cwd: projectDir, stdio: "pipe", timeout: 120_000 })
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
	postgres: "^3.4",
	zod: "^3.24",
	nitro: "latest",
}

const ADDED_DEV_DEPENDENCIES: Record<string, string> = {
	"drizzle-kit": "0.31.9",
}

const ADDED_SCRIPTS: Record<string, string> = {
	generate: "drizzle-kit generate",
	migrate: "drizzle-kit migrate",
	"db:push": "drizzle-kit push",
}

function mergeDependencies(projectDir: string): void {
	const pkgPath = path.join(projectDir, "package.json")
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))

	pkg.dependencies = { ...(pkg.dependencies || {}), ...ADDED_DEPENDENCIES }
	pkg.devDependencies = { ...(pkg.devDependencies || {}), ...ADDED_DEV_DEPENDENCIES }
	pkg.scripts = { ...(pkg.scripts || {}), ...ADDED_SCRIPTS }

	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8")
}

function patchViteConfig(projectDir: string): void {
	const vitePath = path.join(projectDir, "vite.config.ts")
	if (!fs.existsSync(vitePath)) return

	let content = fs.readFileSync(vitePath, "utf-8")

	// Add nitro import if not present
	if (!content.includes("nitro")) {
		content = `import { nitro } from "nitro/vite"\n${content}`

		// Add nitro() to plugins array
		content = content.replace(/plugins:\s*\[/, "plugins: [nitro(), ")
	}

	fs.writeFileSync(vitePath, content, "utf-8")
}

function patchRootRoute(projectDir: string): void {
	const rootPath = path.join(projectDir, "src/routes/__root.tsx")
	if (!fs.existsSync(rootPath)) return

	let content = fs.readFileSync(rootPath, "utf-8")

	// Replace component with shellComponent if not already done
	if (!content.includes("shellComponent") && content.includes("component:")) {
		content = content.replace(
			/component:\s*RootDocument/,
			"shellComponent: RootDocument,\n  component: () => <Outlet />",
		)
	}

	fs.writeFileSync(rootPath, content, "utf-8")
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

	if (additions.length > 0) {
		content += "\n# Electric Agent\n" + additions.join("\n") + "\n"
		fs.writeFileSync(gitignorePath, content, "utf-8")
	}
}
