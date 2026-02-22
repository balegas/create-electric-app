import { Daytona, type Sandbox } from "@daytonaio/sdk"
import { ensureSnapshot } from "./daytona-registry.js"
import type {
	CreateSandboxOpts,
	GitStatus,
	InfraConfig,
	SandboxHandle,
	SandboxProvider,
} from "./types.js"

// ---------------------------------------------------------------------------
// DaytonaSandboxProvider — cloud sandboxes via Daytona
// ---------------------------------------------------------------------------

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "electric-agent-sandbox"

export class DaytonaSandboxProvider implements SandboxProvider {
	readonly runtime = "daytona" as const

	private client: Daytona
	private handles = new Map<string, SandboxHandle>()
	private sandboxes = new Map<string, Sandbox>()
	private apiKey: string
	private apiUrl?: string
	private cachedSnapshot: string | null = null

	constructor(opts?: { apiKey?: string; apiUrl?: string; target?: string }) {
		this.apiKey = opts?.apiKey ?? process.env.DAYTONA_API_KEY ?? ""
		this.apiUrl = opts?.apiUrl ?? process.env.DAYTONA_API_URL
		this.client = new Daytona({
			apiKey: this.apiKey,
			apiUrl: this.apiUrl,
			target: opts?.target ?? process.env.DAYTONA_TARGET ?? "us",
		})
	}

	private getSandbox(handle: SandboxHandle): Sandbox {
		const sb = this.sandboxes.get(handle.sessionId)
		if (!sb) throw new Error(`No Daytona sandbox for session ${handle.sessionId}`)
		return sb
	}

	private async resolveSnapshot(): Promise<string> {
		if (this.cachedSnapshot) return this.cachedSnapshot

		const snapshotName = await ensureSnapshot(this.client, {
			apiKey: this.apiKey,
			apiUrl: this.apiUrl,
			localImage: SANDBOX_IMAGE,
		})

		this.cachedSnapshot = snapshotName
		return snapshotName
	}

	async create(sessionId: string, opts?: CreateSandboxOpts): Promise<SandboxHandle> {
		const infra: InfraConfig = opts?.infra ?? { mode: "local" }
		const isCloud = infra.mode === "cloud"
		const projectName = opts?.projectName || sessionId.slice(0, 8)

		console.log(
			`[daytona] Creating sandbox: session=${sessionId} project=${projectName} image=${SANDBOX_IMAGE} infra=${infra.mode}`,
		)

		const envVars: Record<string, string> = {
			SANDBOX_MODE: "1",
			VITE_PORT: "5173",
		}

		if (isCloud) {
			envVars.DATABASE_URL = infra.databaseUrl
			envVars.ELECTRIC_URL = infra.electricUrl
			envVars.ELECTRIC_SOURCE_ID = infra.sourceId
			envVars.ELECTRIC_SECRET = infra.secret
		}

		const apiKey = opts?.apiKey || process.env.ANTHROPIC_API_KEY
		if (apiKey) {
			envVars.ANTHROPIC_API_KEY = apiKey
		} else if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
			envVars.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN
		}

		const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
		if (ghToken) {
			envVars.GH_TOKEN = ghToken
		}

		// Add stream env vars for hosted Durable Streams communication
		if (opts?.streamEnv) {
			Object.assign(envVars, opts.streamEnv)
		}

		// Ensure a Daytona snapshot exists (push image + create snapshot if needed)
		const snapshotName = await this.resolveSnapshot()

		console.log(
			`[daytona] Creating sandbox from snapshot "${snapshotName}" with ${Object.keys(envVars).length} env vars...`,
		)
		const sandbox = await this.client.create(
			{
				snapshot: snapshotName,
				envVars,
				labels: { sessionId, projectName },
			},
			{ timeout: 120 },
		)
		console.log(`[daytona] Sandbox created, getting preview link...`)

		const previewLink = await sandbox.getPreviewLink(5173)
		const projectDir = `/home/agent/workspace/${projectName}`

		console.log(`[daytona] Preview URL: ${previewLink.url}`)

		const handle: SandboxHandle = {
			sessionId,
			runtime: "daytona",
			port: 5173,
			projectDir,
			previewUrl: previewLink.url,
		}

		this.handles.set(sessionId, handle)
		this.sandboxes.set(sessionId, sandbox)

		return handle
	}

	async destroy(handle: SandboxHandle): Promise<void> {
		const sandbox = this.sandboxes.get(handle.sessionId)
		this.handles.delete(handle.sessionId)
		this.sandboxes.delete(handle.sessionId)

		if (sandbox) {
			try {
				await sandbox.delete(30)
			} catch {
				// Sandbox may already be deleted
			}
		}
	}

	async restartAgent(handle: SandboxHandle): Promise<SandboxHandle> {
		const sandbox = this.getSandbox(handle)

		// Kill any running agent process, then restart
		try {
			await sandbox.process.executeCommand("pkill -f 'electric-agent headless' || true")
		} catch {
			// Process may not be running
		}

		// Start headless agent in background
		await sandbox.process.executeCommand("nohup electric-agent headless > /tmp/agent.log 2>&1 &")

		const newHandle: SandboxHandle = { ...handle }
		this.handles.set(handle.sessionId, newHandle)
		return newHandle
	}

	get(sessionId: string): SandboxHandle | undefined {
		return this.handles.get(sessionId)
	}

	list(): SandboxHandle[] {
		return [...this.handles.values()]
	}

	isAlive(handle: SandboxHandle): boolean {
		const sandbox = this.sandboxes.get(handle.sessionId)
		if (!sandbox) return false
		return sandbox.state === "started"
	}

	async exec(handle: SandboxHandle, command: string): Promise<string> {
		const sandbox = this.getSandbox(handle)
		const result = await sandbox.process.executeCommand(command, undefined, undefined, 30)
		return result.result?.trim() ?? ""
	}

	async listFiles(handle: SandboxHandle, dir: string): Promise<string[]> {
		const sandbox = this.sandboxes.get(handle.sessionId)
		if (!sandbox) return []

		try {
			const result = await sandbox.process.executeCommand(
				`find ${dir} -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.next/*' -not -path '*/.cache/*' -not -path '*/.electric/*' -not -name 'pnpm-lock.yaml' -not -name 'package-lock.json'`,
				undefined,
				undefined,
				10,
			)
			return (result.result ?? "")
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean)
		} catch {
			return []
		}
	}

	async readFile(handle: SandboxHandle, filePath: string): Promise<string | null> {
		const sandbox = this.sandboxes.get(handle.sessionId)
		if (!sandbox) return null

		try {
			const buffer = await sandbox.fs.downloadFile(filePath, 5)
			return buffer.toString("utf-8")
		} catch {
			return null
		}
	}

	async startApp(handle: SandboxHandle): Promise<boolean> {
		const sandbox = this.sandboxes.get(handle.sessionId)
		if (!sandbox) return false

		try {
			await sandbox.process.executeCommand(
				"cd /home/agent/workspace/*/ && pnpm dev:start",
				undefined,
				undefined,
				10,
			)
			return true
		} catch {
			return false
		}
	}

	async stopApp(handle: SandboxHandle): Promise<boolean> {
		const sandbox = this.sandboxes.get(handle.sessionId)
		if (!sandbox) return false

		try {
			await sandbox.process.executeCommand(
				"cd /home/agent/workspace/*/ && pnpm dev:stop",
				undefined,
				undefined,
				5,
			)
			return true
		} catch {
			return false
		}
	}

	async isAppRunning(handle: SandboxHandle): Promise<boolean> {
		const sandbox = this.sandboxes.get(handle.sessionId)
		if (!sandbox) return false

		try {
			const result = await sandbox.process.executeCommand(
				"kill -0 $(cat /tmp/dev-server.pid 2>/dev/null) 2>/dev/null && echo RUNNING || echo STOPPED",
				undefined,
				undefined,
				5,
			)
			return (result.result ?? "").includes("RUNNING")
		} catch {
			return false
		}
	}

	async gitStatus(handle: SandboxHandle, projectDir: string): Promise<GitStatus> {
		const sandbox = this.sandboxes.get(handle.sessionId)
		if (!sandbox) {
			return {
				initialized: false,
				branch: null,
				hasUncommitted: false,
				lastCommitHash: null,
				lastCommitMessage: null,
			}
		}

		try {
			const initCheck = await sandbox.process.executeCommand(
				`cd ${projectDir} && test -d .git && echo "GIT_INIT=yes" || echo "GIT_INIT=no"`,
			)
			if (!(initCheck.result ?? "").includes("GIT_INIT=yes")) {
				return {
					initialized: false,
					branch: null,
					hasUncommitted: false,
					lastCommitHash: null,
					lastCommitMessage: null,
				}
			}

			const branch = (
				await sandbox.process.executeCommand(
					`cd ${projectDir} && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""`,
				)
			).result?.trim()
			const hash = (
				await sandbox.process.executeCommand(
					`cd ${projectDir} && git rev-parse HEAD 2>/dev/null || echo ""`,
				)
			).result?.trim()
			const message = (
				await sandbox.process.executeCommand(
					`cd ${projectDir} && git log -1 --format=%s 2>/dev/null || echo ""`,
				)
			).result?.trim()
			const statusOutput = (
				await sandbox.process.executeCommand(
					`cd ${projectDir} && git status --porcelain 2>/dev/null || echo ""`,
				)
			).result?.trim()

			return {
				initialized: true,
				branch: branch || null,
				hasUncommitted: (statusOutput ?? "").length > 0,
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

	async getPreviewUrl(handle: SandboxHandle, port: number): Promise<string | null> {
		const sandbox = this.sandboxes.get(handle.sessionId)
		if (!sandbox) return null

		try {
			const preview = await sandbox.getPreviewLink(port)
			return preview.url
		} catch {
			return null
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
		const sandbox = this.getSandbox(handle)

		const targetDir = `/home/agent/workspace/${repoName}`
		await sandbox.process.executeCommand(
			`gh repo clone "${repoUrl}" "${targetDir}" 2>/dev/null || git clone "${repoUrl}" "${targetDir}"`,
			undefined,
			undefined,
			60,
		)

		if (opts?.branch) {
			await sandbox.process.executeCommand(`cd ${targetDir} && git checkout ${opts.branch}`)
		}

		handle.projectDir = targetDir
		return handle
	}
}
