import { type ChildProcess, execFileSync, execSync, spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

export interface ContainerHandle {
	containerId: string
	sessionId: string
	process: ChildProcess
	port: number
	/** Path to the temp dir holding the compose file */
	composeDir: string
	/** Compose project name */
	composeProject: string
}

const activeContainers = new Map<string, ContainerHandle>()

const SANDBOX_IMAGE = "electric-agent-sandbox"

/**
 * Try to read the Claude OAuth access token from the macOS Keychain.
 * Returns null on non-macOS platforms or if the token isn't found.
 */
function readKeychainOAuthToken(): string | null {
	if (process.platform !== "darwin") return null
	try {
		const raw = execFileSync(
			"security",
			["find-generic-password", "-s", "Claude Code-credentials", "-w"],
			{ encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
		).trim()
		const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } }
		return parsed.claudeAiOauth?.accessToken ?? null
	} catch {
		return null
	}
}

/**
 * Find a free port on the host for mapping the container's dev server.
 */
export function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer()
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address()
			if (addr && typeof addr === "object") {
				const port = addr.port
				server.close(() => resolve(port))
			} else {
				server.close(() => reject(new Error("Could not determine free port")))
			}
		})
		server.on("error", reject)
	})
}

/**
 * Resolve the auth env var to pass into the agent container.
 * Returns [key, value] or null if no credentials found.
 */
function resolveAuthEnv(opts?: { apiKey?: string }): [string, string] | null {
	const apiKey = opts?.apiKey || process.env.ANTHROPIC_API_KEY
	if (apiKey) return ["ANTHROPIC_API_KEY", apiKey]
	if (process.env.CLAUDE_CODE_OAUTH_TOKEN)
		return ["CLAUDE_CODE_OAUTH_TOKEN", process.env.CLAUDE_CODE_OAUTH_TOKEN]
	const oauthToken = readKeychainOAuthToken()
	if (oauthToken) return ["CLAUDE_CODE_OAUTH_TOKEN", oauthToken]
	return null
}

/**
 * Generate a docker-compose.yml for a session's sandbox stack.
 */
function generateComposeFile(port: number, auth: [string, string] | null): string {
	const agentEnv = [
		"DATABASE_URL=postgresql://postgres:password@postgres:5432/electric",
		"ELECTRIC_URL=http://electric:3000",
		"SANDBOX_MODE=1",
	]
	if (auth) {
		agentEnv.push(`${auth[0]}=${auth[1]}`)
	}

	const agentEnvYaml = agentEnv.map((e) => `      - ${e}`).join("\n")

	return `services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_DB: electric
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
    command: postgres -c wal_level=logical -c max_replication_slots=10 -c max_wal_senders=10
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 2s
      timeout: 5s
      retries: 10

  electric:
    image: electricsql/electric:latest
    environment:
      DATABASE_URL: postgresql://postgres:password@postgres:5432/electric
      ELECTRIC_INSECURE: "true"
    depends_on:
      postgres:
        condition: service_healthy

  agent:
    image: ${SANDBOX_IMAGE}
    stdin_open: true
    ports:
      - "${port}:5173"
    environment:
${agentEnvYaml}
    depends_on:
      electric:
        condition: service_started
    command: ["electric-agent", "headless"]
`
}

/**
 * Spawn the full sandbox stack for a session using docker compose.
 *
 * 1. Write a docker-compose.yml to a temp dir
 * 2. Run `docker compose up -d postgres electric` and wait for healthy
 * 3. Run `docker compose run agent` with stdin attached for the headless protocol
 */
export async function createContainer(
	sessionId: string,
	opts?: { apiKey?: string },
): Promise<ContainerHandle> {
	const port = await findFreePort()
	const project = `ea-${sessionId.slice(0, 8)}`

	// Write compose file to a temp dir
	const composeDir = fs.mkdtempSync(path.join(os.tmpdir(), `${project}-`))
	const composePath = path.join(composeDir, "docker-compose.yml")
	const auth = resolveAuthEnv(opts)
	fs.writeFileSync(composePath, generateComposeFile(port, auth), "utf-8")

	// Start infra services (postgres + electric) in background
	execSync(`docker compose -p ${project} -f ${composePath} up -d postgres electric`, {
		stdio: "pipe",
		timeout: 120_000,
	})

	// Wait for Electric to be reachable (postgres health is handled by depends_on)
	await waitForElectric(project, composePath)

	// Start the agent with stdin attached via `docker compose run`
	const child = spawn(
		"docker",
		["compose", "-p", project, "-f", composePath, "run", "--rm", "-i", "--service-ports", "agent"],
		{ stdio: ["pipe", "pipe", "pipe"] },
	)

	const agentContainerName = `${project}-agent`

	const handle: ContainerHandle = {
		containerId: agentContainerName,
		sessionId,
		process: child,
		port,
		composeDir,
		composeProject: project,
	}

	activeContainers.set(sessionId, handle)

	child.on("exit", () => {
		activeContainers.delete(sessionId)
	})

	return handle
}

/**
 * Wait for Electric to respond to health checks inside the compose stack.
 */
async function waitForElectric(project: string, composePath: string): Promise<void> {
	const start = Date.now()
	while (Date.now() - start < 60_000) {
		try {
			execSync(
				`docker compose -p ${project} -f ${composePath} exec -T electric curl -sf http://localhost:3000/v1/health`,
				{ stdio: "ignore", timeout: 3000 },
			)
			return
		} catch {
			// Not ready yet
		}
		await new Promise((r) => setTimeout(r, 1000))
	}
	throw new Error("Electric did not become healthy in time")
}

/**
 * Write the initial JSON config to the container's stdin (first line).
 */
export function sendCommand(handle: ContainerHandle, config: Record<string, unknown>): void {
	handle.process.stdin?.write(`${JSON.stringify(config)}\n`)
}

/**
 * Write a gate response to the container's stdin.
 */
export function sendGateResponse(
	handle: ContainerHandle,
	gate: string,
	value: Record<string, unknown>,
): void {
	handle.process.stdin?.write(`${JSON.stringify({ gate, ...value })}\n`)
}

/**
 * Tear down the entire compose stack and clean up.
 */
export function destroyContainer(handle: ContainerHandle): void {
	activeContainers.delete(handle.sessionId)
	try {
		handle.process.kill()
	} catch {
		// Process may already be dead
	}
	// Tear down all compose services and remove volumes
	const composePath = path.join(handle.composeDir, "docker-compose.yml")
	spawn(
		"docker",
		["compose", "-p", handle.composeProject, "-f", composePath, "down", "-v", "--remove-orphans"],
		{ stdio: "ignore" },
	)
	// Clean up temp dir after a delay (let compose down finish)
	setTimeout(() => {
		fs.rm(handle.composeDir, { recursive: true, force: true }, () => {})
	}, 5000)
}

/**
 * Get the active container handle for a session.
 */
export function getContainer(sessionId: string): ContainerHandle | undefined {
	return activeContainers.get(sessionId)
}
