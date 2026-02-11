import { execSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import { createProgressReporter } from "../progress/reporter.js"

function run(cmd: string, cwd: string): void {
	execSync(cmd, { cwd, stdio: "inherit" })
}

function runQuiet(cmd: string, cwd: string): string {
	return execSync(cmd, { cwd, encoding: "utf-8" }).trim()
}

async function waitForHealth(url: string, maxAttempts = 30): Promise<boolean> {
	for (let i = 0; i < maxAttempts; i++) {
		try {
			const response = await fetch(url)
			if (response.ok) return true
		} catch {
			// Service not ready yet
		}
		await new Promise((resolve) => setTimeout(resolve, 2000))
	}
	return false
}

export async function upCommand(): Promise<void> {
	const projectDir = process.cwd()
	const reporter = createProgressReporter()

	if (!fs.existsSync(path.join(projectDir, "docker-compose.yml"))) {
		reporter.log("error", "No docker-compose.yml found in current directory")
		process.exit(1)
	}

	// Step 1: Start Docker services
	reporter.log("task", "Starting Docker services...")
	run("docker compose up -d", projectDir)

	// Step 2: Wait for Postgres
	reporter.log("task", "Waiting for Postgres to be ready...")
	try {
		runQuiet(
			'docker compose exec -T postgres pg_isready -U postgres --timeout=30 || echo "waiting..."',
			projectDir,
		)
	} catch {
		// pg_isready might not be available, wait a bit
		await new Promise((resolve) => setTimeout(resolve, 5000))
	}

	// Step 3: Wait for Electric
	reporter.log("task", "Waiting for Electric to be ready...")
	const electricHealthy = await waitForHealth("http://localhost:3000/v1/health")
	if (!electricHealthy) {
		reporter.log("error", "Electric failed to start. Check 'docker compose logs electric'")
	}

	// Step 4: Trust Caddy CA (best effort)
	reporter.log("task", "Checking Caddy certificate trust...")
	try {
		runQuiet("which caddy", projectDir)
		run("caddy trust 2>/dev/null || true", projectDir)
		reporter.log("done", "Caddy CA trusted")
	} catch {
		reporter.log(
			"task",
			"Caddy not found locally. You may need to accept the self-signed certificate in your browser.",
		)
	}

	// Step 5: Run migrations
	reporter.log("task", "Running database migrations...")
	try {
		run("npx drizzle-kit migrate", projectDir)
		reporter.log("done", "Migrations applied")
	} catch {
		reporter.log("error", "Migration failed. Check your schema and database connection.")
	}

	// Step 6: Start dev server
	reporter.log("task", "Starting dev server...")
	reporter.log("done", "Access your app at https://localhost:5173 (Caddy) or http://localhost:5174")
	run("pnpm dev", projectDir)
}
