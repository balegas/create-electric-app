import { execFileSync, execSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type {
	CreateSandboxOpts,
	GitStatus,
	InfraConfig,
	SandboxHandle,
	SandboxProvider,
} from "./types.js"

// ---------------------------------------------------------------------------
// Docker-specific internal state (not exposed in the handle)
// ---------------------------------------------------------------------------

interface DockerInternalState {
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

function resolveAuthEnv(opts?: { apiKey?: string; oauthToken?: string }): [string, string] | null {
	if (opts?.oauthToken) return ["CLAUDE_CODE_OAUTH_TOKEN", opts.oauthToken]
	if (opts?.apiKey) return ["ANTHROPIC_API_KEY", opts.apiKey]
	return null
}

function generateComposeFile(
	port: number,
	auth: [string, string] | null,
	infra: InfraConfig = { mode: "local" },
	ghToken?: string,
): string {
	const isCloud = infra.mode === "cloud"
	const isNone = infra.mode === "none"

	const agentEnv = ["VITE_PORT=5173", "SANDBOX_MODE=1"]
	if (!isNone) {
		agentEnv.push(
			`DATABASE_URL=${isCloud ? infra.databaseUrl : "postgresql://postgres:password@postgres:5432/electric"}`,
			`ELECTRIC_URL=${isCloud ? infra.electricUrl : "http://electric:3000"}`,
		)
	}
	if (isCloud) {
		agentEnv.push(`ELECTRIC_SOURCE_ID=${infra.sourceId}`)
		agentEnv.push(`ELECTRIC_SECRET=${infra.secret}`)
	}
	if (auth) {
		agentEnv.push(`${auth[0]}=${auth[1]}`)
	}
	if (ghToken) {
		agentEnv.push(`GH_TOKEN=${ghToken}`)
	}

	const agentEnvYaml = agentEnv.map((e) => `      - ${e}`).join("\n")

	// Keep the container alive — the Claude Code bridge starts the agent
	const agentCommand = '["tail", "-f", "/dev/null"]'

	if (isCloud || isNone) {
		return `services:
  agent:
    image: ${SANDBOX_IMAGE}
    ports:
      - "${port}:5173"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
${agentEnvYaml}
    volumes:
      - workspace:/home/agent/workspace
    stdin_open: true
    command: ${agentCommand}

volumes:
  workspace:
`
	}

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
    ports:
      - "${port}:5173"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
${agentEnvYaml}
    volumes:
      - workspace:/home/agent/workspace
    depends_on:
      electric:
        condition: service_started
    stdin_open: true
    command: ${agentCommand}

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

function getAgentContainerId(state: DockerInternalState): string | null {
	try {
		const composePath = path.join(state.composeDir, "docker-compose.yml")
		const id = execFileSync(
			"docker",
			["compose", "-p", state.composeProject, "-f", composePath, "ps", "-q", "agent"],
			{ encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
		).trim()
		return id || null
	} catch {
		return null
	}
}

function execInContainer(
	state: DockerInternalState,
	command: string,
	opts?: { timeout?: number },
): string {
	const containerId = getAgentContainerId(state)
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
	readonly runtime = "docker" as const

	private activeContainers = new Map<string, SandboxHandle>()
	private internalState = new Map<string, DockerInternalState>()

	private getState(handle: SandboxHandle): DockerInternalState {
		const state = this.internalState.get(handle.sessionId)
		if (!state) throw new Error(`No internal state for session ${handle.sessionId}`)
		return state
	}

	async create(sessionId: string, opts?: CreateSandboxOpts): Promise<SandboxHandle> {
		const port = await findFreePort()
		const slug = (opts?.projectName || sessionId.slice(0, 8))
			.replace(/[^a-z0-9-]/gi, "-")
			.toLowerCase()
		const project = `ea-${slug}`
		const infra: InfraConfig = opts?.infra ?? { mode: "local" }

		console.log(
			`[docker] Creating sandbox: session=${sessionId} project=${project} port=${port} infra=${infra.mode}`,
		)

		const composeDir = fs.mkdtempSync(path.join(os.tmpdir(), `${project}-`))
		const composePath = path.join(composeDir, "docker-compose.yml")
		const auth = resolveAuthEnv(opts)
		fs.writeFileSync(composePath, generateComposeFile(port, auth, infra, opts?.ghToken), "utf-8")
		console.log(`[docker] Compose file written: ${composePath}`)

		if (infra.mode === "local") {
			console.log(`[docker] Starting postgres + electric...`)
			execSync(`docker compose -p ${project} -f ${composePath} up -d postgres electric`, {
				stdio: "pipe",
				timeout: 120_000,
			})
			await waitForElectric(project, composePath)
			console.log(`[docker] Electric is ready`)
		}

		// Start the agent service in detached mode — it communicates via the durable stream
		console.log(`[docker] Starting agent container...`)
		execSync(`docker compose -p ${project} -f ${composePath} up -d agent`, {
			stdio: "pipe",
			timeout: 60_000,
		})
		console.log(`[docker] Agent container started`)

		const handle: SandboxHandle = {
			sessionId,
			runtime: "docker",
			port,
			projectDir: `/home/agent/workspace/${opts?.projectName || sessionId.slice(0, 8)}`,
		}

		const state: DockerInternalState = {
			composeDir,
			composeProject: project,
		}

		this.activeContainers.set(sessionId, handle)
		this.internalState.set(sessionId, state)

		// In prod mode, install git credential helper that fetches tokens from studio server
		if (opts?.prodMode) {
			// Docker containers can't reach localhost — rewrite to host.docker.internal
			const studioUrl = opts.prodMode.studioUrl.replace(
				/localhost|127\.0\.0\.1/,
				"host.docker.internal",
			)
			this.installCredentialHelper(state, sessionId, opts.prodMode.sessionToken, studioUrl)
		}

		return handle
	}

	private installCredentialHelper(
		state: DockerInternalState,
		sessionId: string,
		sessionToken: string,
		studioUrl: string,
	): void {
		// Embed actual values directly in the script — profile.d files
		// are not sourced in non-login shells (e.g. when git calls the helper)
		const script = `#!/bin/bash
# git-credential-electric: fetches GitHub tokens from studio server
if [ "$1" != "get" ]; then exit 0; fi

input=$(cat)
host=$(echo "$input" | grep "^host=" | cut -d= -f2)
if [ "$host" != "github.com" ]; then exit 0; fi

SESSION_TOKEN="${sessionToken}"
SESSION_ID="${sessionId}"
STUDIO_URL="${studioUrl}"

response=$(curl -s -w "\\\\n%{http_code}" -X POST \\
  -H "Authorization: Bearer $SESSION_TOKEN" \\
  "$STUDIO_URL/api/sessions/$SESSION_ID/github-token")

http_code=$(echo "$response" | tail -1)
body_text=$(echo "$response" | head -n -1)

if [ "$http_code" != "200" ]; then
  echo "git-credential-electric: failed to fetch token (HTTP $http_code)" >&2
  exit 1
fi

token=$(echo "$body_text" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$token" ] && [ "$token" != "null" ]; then
  echo "protocol=https"
  echo "host=github.com"
  echo "username=x-access-token"
  echo "password=$token"
else
  echo "git-credential-electric: invalid token response" >&2
  exit 1
fi`

		// Write credential helper script via base64 to avoid quoting issues
		// Use /home/agent/bin since the container user may not have write access to /usr/local/bin
		const scriptB64 = Buffer.from(script).toString("base64")
		execInContainer(
			state,
			`mkdir -p /home/agent/bin && echo ${scriptB64} | base64 -d > /home/agent/bin/git-credential-electric && chmod +x /home/agent/bin/git-credential-electric`,
		)

		// Configure git to use our credential helper (full path so git finds it regardless of PATH)
		execInContainer(
			state,
			`git config --global credential.helper /home/agent/bin/git-credential-electric`,
		)

		console.log(`[docker] Credential helper installed for session ${sessionId}`)
	}

	async destroy(handle: SandboxHandle): Promise<void> {
		const state = this.internalState.get(handle.sessionId)
		this.activeContainers.delete(handle.sessionId)
		this.internalState.delete(handle.sessionId)

		if (!state) return

		const composePath = path.join(state.composeDir, "docker-compose.yml")
		try {
			execSync(
				`docker compose -p ${state.composeProject} -f ${composePath} down -v --remove-orphans`,
				{ stdio: "ignore", timeout: 30_000 },
			)
		} catch {
			// Best effort
		}
		setTimeout(() => {
			fs.rm(state.composeDir, { recursive: true, force: true }, () => {})
		}, 5000)
	}

	/** Get the Docker container ID for a session's agent service */
	getContainerId(sessionId: string): string | null {
		const state = this.internalState.get(sessionId)
		if (!state) return null
		return getAgentContainerId(state)
	}

	get(sessionId: string): SandboxHandle | undefined {
		return this.activeContainers.get(sessionId)
	}

	list(): SandboxHandle[] {
		return [...this.activeContainers.values()]
	}

	isAlive(handle: SandboxHandle): boolean {
		const state = this.internalState.get(handle.sessionId)
		if (!state) return false
		const containerId = getAgentContainerId(state)
		return containerId !== null
	}

	async exec(handle: SandboxHandle, command: string): Promise<string> {
		const state = this.getState(handle)
		return execInContainer(state, command).trim()
	}

	async listFiles(handle: SandboxHandle, dir: string): Promise<string[]> {
		const state = this.internalState.get(handle.sessionId)
		if (!state) return []

		const containerId = getAgentContainerId(state)
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

	async readFile(handle: SandboxHandle, filePath: string): Promise<string | null> {
		const state = this.internalState.get(handle.sessionId)
		if (!state) return null

		const containerId = getAgentContainerId(state)
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
		const state = this.internalState.get(handle.sessionId)
		if (!state) return false

		const containerId = getAgentContainerId(state)
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
		const state = this.internalState.get(handle.sessionId)
		if (!state) return false

		const containerId = getAgentContainerId(state)
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

	async isAppRunning(handle: SandboxHandle): Promise<boolean> {
		const state = this.internalState.get(handle.sessionId)
		if (!state) return false

		const containerId = getAgentContainerId(state)
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

	async gitStatus(handle: SandboxHandle, projectDir: string): Promise<GitStatus> {
		const state = this.internalState.get(handle.sessionId)
		if (!state) {
			return {
				initialized: false,
				branch: null,
				hasUncommitted: false,
				lastCommitHash: null,
				lastCommitMessage: null,
			}
		}

		try {
			const output = execInContainer(
				state,
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
				state,
				`cd ${projectDir} && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""`,
			).trim()
			const hash = execInContainer(
				state,
				`cd ${projectDir} && git rev-parse HEAD 2>/dev/null || echo ""`,
			).trim()
			const message = execInContainer(
				state,
				`cd ${projectDir} && git log -1 --format=%s 2>/dev/null || echo ""`,
			).trim()
			const statusOutput = execInContainer(
				state,
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
		opts?: { branch?: string; apiKey?: string; oauthToken?: string; ghToken?: string },
	): Promise<SandboxHandle> {
		const repoName =
			repoUrl
				.split("/")
				.pop()
				?.replace(/\.git$/, "") || "resumed-project"

		const handle = await this.create(sessionId, {
			apiKey: opts?.apiKey,
			oauthToken: opts?.oauthToken,
			ghToken: opts?.ghToken,
			projectName: repoName,
		})
		const state = this.getState(handle)

		const targetDir = `/home/agent/workspace/${repoName}`
		execInContainer(state, `rm -rf "${targetDir}"`)
		execInContainer(
			state,
			`gh repo clone "${repoUrl}" "${targetDir}" 2>/dev/null || git clone "${repoUrl}" "${targetDir}"`,
			{ timeout: 60_000 },
		)

		if (opts?.branch) {
			execInContainer(state, `cd ${targetDir} && git checkout ${opts.branch}`)
		}

		handle.projectDir = targetDir
		return handle
	}
}
