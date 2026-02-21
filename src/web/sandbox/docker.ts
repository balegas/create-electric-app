import { execFileSync, execSync, spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { GitStatus, InfraConfig, SandboxHandle, SandboxProvider } from "./types.js"

// ---------------------------------------------------------------------------
// Docker-specific handle
// ---------------------------------------------------------------------------

interface DockerHandle extends SandboxHandle {
	composeDir: string
	composeProject: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SANDBOX_IMAGE = "electric-agent-sandbox"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Try to read the Claude OAuth access token from the macOS Keychain.
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

function findFreePort(): Promise<number> {
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

function resolveAuthEnv(opts?: { apiKey?: string }): [string, string] | null {
	const apiKey = opts?.apiKey || process.env.ANTHROPIC_API_KEY
	if (apiKey) return ["ANTHROPIC_API_KEY", apiKey]
	if (process.env.CLAUDE_CODE_OAUTH_TOKEN)
		return ["CLAUDE_CODE_OAUTH_TOKEN", process.env.CLAUDE_CODE_OAUTH_TOKEN]
	const oauthToken = readKeychainOAuthToken()
	if (oauthToken) return ["CLAUDE_CODE_OAUTH_TOKEN", oauthToken]
	return null
}

function generateComposeFile(
	port: number,
	auth: [string, string] | null,
	infra: InfraConfig = { mode: "local" },
): string {
	const isCloud = infra.mode === "cloud"

	const agentEnv = [
		`DATABASE_URL=${isCloud ? infra.databaseUrl : "postgresql://postgres:password@postgres:5432/electric"}`,
		`ELECTRIC_URL=${isCloud ? infra.electricUrl : "http://electric:3000"}`,
		"VITE_PORT=5173",
		"SANDBOX_MODE=1",
	]
	if (isCloud) {
		agentEnv.push(`ELECTRIC_SOURCE_ID=${infra.sourceId}`)
		agentEnv.push(`ELECTRIC_SECRET=${infra.secret}`)
	}
	if (auth) {
		agentEnv.push(`${auth[0]}=${auth[1]}`)
	}
	const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
	if (ghToken) {
		agentEnv.push(`GH_TOKEN=${ghToken}`)
	}

	const agentEnvYaml = agentEnv.map((e) => `      - ${e}`).join("\n")

	if (isCloud) {
		// Cloud mode: agent only, no postgres/electric services
		return `services:
  agent:
    image: ${SANDBOX_IMAGE}
    stdin_open: true
    ports:
      - "${port}:5173"
    environment:
${agentEnvYaml}
    volumes:
      - workspace:/home/agent/workspace
    command: ["electric-agent", "headless"]

volumes:
  workspace:
`
	}

	// Local mode: full stack with postgres + electric
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
    volumes:
      - workspace:/home/agent/workspace
    depends_on:
      electric:
        condition: service_started
    command: ["electric-agent", "headless"]

volumes:
  workspace:
`
}

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

function getAgentContainerId(handle: DockerHandle): string | null {
	try {
		const composePath = path.join(handle.composeDir, "docker-compose.yml")
		const id = execFileSync(
			"docker",
			["compose", "-p", handle.composeProject, "-f", composePath, "ps", "-q", "agent"],
			{ encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
		).trim()
		return id || null
	} catch {
		return null
	}
}

function execInContainer(
	handle: DockerHandle,
	command: string,
	opts?: { timeout?: number },
): string {
	const containerId = getAgentContainerId(handle)
	if (!containerId) throw new Error("No running container")
	return execFileSync("docker", ["exec", containerId, "sh", "-c", command], {
		encoding: "utf-8",
		timeout: opts?.timeout ?? 30_000,
		stdio: ["ignore", "pipe", "pipe"],
	})
}

// ---------------------------------------------------------------------------
// DockerSandboxProvider
// ---------------------------------------------------------------------------

export class DockerSandboxProvider implements SandboxProvider {
	private activeContainers = new Map<string, DockerHandle>()

	private toDockerHandle(handle: SandboxHandle): DockerHandle {
		return handle as DockerHandle
	}

	async create(
		sessionId: string,
		opts?: { apiKey?: string; projectName?: string; infra?: InfraConfig },
	): Promise<SandboxHandle> {
		const port = await findFreePort()
		const slug = (opts?.projectName || sessionId.slice(0, 8))
			.replace(/[^a-z0-9-]/gi, "-")
			.toLowerCase()
		const project = `ea-${slug}`
		const infra: InfraConfig = opts?.infra ?? { mode: "local" }

		const composeDir = fs.mkdtempSync(path.join(os.tmpdir(), `${project}-`))
		const composePath = path.join(composeDir, "docker-compose.yml")
		const auth = resolveAuthEnv(opts)
		fs.writeFileSync(composePath, generateComposeFile(port, auth, infra), "utf-8")

		if (infra.mode === "local") {
			// Start postgres + electric for local mode
			execSync(`docker compose -p ${project} -f ${composePath} up -d postgres electric`, {
				stdio: "pipe",
				timeout: 120_000,
			})
			await waitForElectric(project, composePath)
		}

		const child = spawn(
			"docker",
			[
				"compose",
				"-p",
				project,
				"-f",
				composePath,
				"run",
				"--rm",
				"-i",
				"--service-ports",
				"agent",
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		)

		const handle: DockerHandle = {
			sessionId,
			process: child,
			port,
			projectDir: `/home/agent/workspace/${opts?.projectName || sessionId.slice(0, 8)}`,
			composeDir,
			composeProject: project,
		}

		this.activeContainers.set(sessionId, handle)
		child.on("exit", () => {
			this.activeContainers.delete(sessionId)
		})

		return handle
	}

	destroy(handle: SandboxHandle): void {
		const dh = this.toDockerHandle(handle)
		this.activeContainers.delete(dh.sessionId)
		try {
			dh.process.kill()
		} catch {
			// Process may already be dead
		}
		const composePath = path.join(dh.composeDir, "docker-compose.yml")
		spawn(
			"docker",
			["compose", "-p", dh.composeProject, "-f", composePath, "down", "-v", "--remove-orphans"],
			{ stdio: "ignore" },
		)
		setTimeout(() => {
			fs.rm(dh.composeDir, { recursive: true, force: true }, () => {})
		}, 5000)
	}

	async restartAgent(sessionId: string): Promise<SandboxHandle> {
		const existing = this.activeContainers.get(sessionId)
		if (!existing) {
			throw new Error("No active container for session")
		}

		try {
			existing.process.kill()
		} catch {
			// Process may already be dead
		}
		this.activeContainers.delete(sessionId)

		const composePath = path.join(existing.composeDir, "docker-compose.yml")

		const child = spawn(
			"docker",
			[
				"compose",
				"-p",
				existing.composeProject,
				"-f",
				composePath,
				"run",
				"--rm",
				"-i",
				"--service-ports",
				"agent",
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		)

		const handle: DockerHandle = {
			sessionId,
			process: child,
			port: existing.port,
			projectDir: existing.projectDir,
			composeDir: existing.composeDir,
			composeProject: existing.composeProject,
		}

		this.activeContainers.set(sessionId, handle)
		child.on("exit", () => {
			this.activeContainers.delete(sessionId)
		})

		return handle
	}

	get(sessionId: string): SandboxHandle | undefined {
		return this.activeContainers.get(sessionId)
	}

	sendCommand(handle: SandboxHandle, config: Record<string, unknown>): void {
		handle.process.stdin?.write(`${JSON.stringify(config)}\n`)
	}

	sendGateResponse(handle: SandboxHandle, gate: string, value: Record<string, unknown>): void {
		handle.process.stdin?.write(`${JSON.stringify({ gate, ...value })}\n`)
	}

	listFiles(handle: SandboxHandle, dir: string): string[] {
		const dh = this.toDockerHandle(handle)
		const containerId = getAgentContainerId(dh)
		if (!containerId) return []

		try {
			const output = execFileSync(
				"docker",
				[
					"exec",
					containerId,
					"find",
					dir,
					"-type",
					"f",
					"-not",
					"-path",
					"*/node_modules/*",
					"-not",
					"-path",
					"*/.git/*",
					"-not",
					"-path",
					"*/dist/*",
					"-not",
					"-path",
					"*/.next/*",
					"-not",
					"-path",
					"*/.cache/*",
					"-not",
					"-path",
					"*/.electric/*",
					"-not",
					"-name",
					"pnpm-lock.yaml",
					"-not",
					"-name",
					"package-lock.json",
				],
				{ encoding: "utf-8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] },
			)
			return output
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean)
		} catch {
			return []
		}
	}

	readFile(handle: SandboxHandle, filePath: string): string | null {
		const dh = this.toDockerHandle(handle)
		const containerId = getAgentContainerId(dh)
		if (!containerId) return null

		try {
			return execFileSync("docker", ["exec", containerId, "cat", filePath], {
				encoding: "utf-8",
				timeout: 5_000,
				stdio: ["ignore", "pipe", "ignore"],
			})
		} catch {
			return null
		}
	}

	async startApp(handle: SandboxHandle): Promise<boolean> {
		const dh = this.toDockerHandle(handle)
		const containerId = getAgentContainerId(dh)
		if (!containerId) return false

		try {
			execFileSync(
				"docker",
				["exec", containerId, "sh", "-c", "cd /home/agent/workspace/*/ && pnpm dev:start"],
				{ timeout: 10_000, stdio: "ignore" },
			)
			return true
		} catch {
			return false
		}
	}

	async stopApp(handle: SandboxHandle): Promise<boolean> {
		const dh = this.toDockerHandle(handle)
		const containerId = getAgentContainerId(dh)
		if (!containerId) return false

		try {
			execFileSync(
				"docker",
				["exec", containerId, "sh", "-c", "cd /home/agent/workspace/*/ && pnpm dev:stop"],
				{ timeout: 5000, stdio: "ignore" },
			)
			return true
		} catch {
			return false
		}
	}

	isAppRunning(handle: SandboxHandle): boolean {
		const dh = this.toDockerHandle(handle)
		const containerId = getAgentContainerId(dh)
		if (!containerId) return false

		try {
			execFileSync(
				"docker",
				[
					"exec",
					containerId,
					"sh",
					"-c",
					"kill -0 $(cat /tmp/dev-server.pid 2>/dev/null) 2>/dev/null",
				],
				{ timeout: 5000, stdio: "ignore" },
			)
			return true
		} catch {
			return false
		}
	}

	gitStatus(handle: SandboxHandle, projectDir: string): GitStatus {
		const dh = this.toDockerHandle(handle)
		try {
			const output = execInContainer(
				dh,
				`cd ${projectDir} && test -d .git && echo "GIT_INIT=yes" || echo "GIT_INIT=no"`,
			)
			if (!output.includes("GIT_INIT=yes")) {
				return {
					initialized: false,
					branch: null,
					hasUncommitted: false,
					lastCommitHash: null,
					lastCommitMessage: null,
				}
			}

			const branch = execInContainer(
				dh,
				`cd ${projectDir} && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""`,
			).trim()
			const hash = execInContainer(
				dh,
				`cd ${projectDir} && git rev-parse HEAD 2>/dev/null || echo ""`,
			).trim()
			const message = execInContainer(
				dh,
				`cd ${projectDir} && git log -1 --format=%s 2>/dev/null || echo ""`,
			).trim()
			const statusOutput = execInContainer(
				dh,
				`cd ${projectDir} && git status --porcelain 2>/dev/null || echo ""`,
			).trim()

			return {
				initialized: true,
				branch: branch || null,
				hasUncommitted: statusOutput.length > 0,
				lastCommitHash: hash || null,
				lastCommitMessage: message || null,
			}
		} catch {
			return {
				initialized: false,
				branch: null,
				hasUncommitted: false,
				lastCommitHash: null,
				lastCommitMessage: null,
			}
		}
	}

	async createFromRepo(
		sessionId: string,
		repoUrl: string,
		opts?: { branch?: string; apiKey?: string },
	): Promise<SandboxHandle> {
		const repoName =
			repoUrl
				.split("/")
				.pop()
				?.replace(/\.git$/, "") || "resumed-project"

		const handle = await this.create(sessionId, {
			apiKey: opts?.apiKey,
			projectName: repoName,
		})
		const dh = this.toDockerHandle(handle)

		// Clone the repo inside the container
		const targetDir = `/home/agent/workspace/${repoName}`
		execInContainer(
			dh,
			`gh repo clone "${repoUrl}" "${targetDir}" 2>/dev/null || git clone "${repoUrl}" "${targetDir}"`,
			{ timeout: 60_000 },
		)

		if (opts?.branch) {
			execInContainer(dh, `cd ${targetDir} && git checkout ${opts.branch}`)
		}

		// Update projectDir on the handle
		handle.projectDir = targetDir

		return handle
	}
}
