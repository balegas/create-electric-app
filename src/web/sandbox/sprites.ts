import { type Sprite, SpritesClient } from "@fly/sprites"
import { ensureBootstrapped } from "./sprites-bootstrap.js"
import type {
	CreateSandboxOpts,
	GitStatus,
	InfraConfig,
	SandboxHandle,
	SandboxProvider,
} from "./types.js"

// ---------------------------------------------------------------------------
// SpritesSandboxProvider — cloud sandboxes via Fly.io Sprites
// ---------------------------------------------------------------------------

const DEFAULT_REGION = "ord"
const DEFAULT_RAM_MB = 2048
const DEFAULT_CPUS = 2

export class SpritesSandboxProvider implements SandboxProvider {
	readonly runtime = "sprites" as const

	private client: SpritesClient
	private token: string
	private baseURL: string
	private handles = new Map<string, SandboxHandle>()
	private sprites = new Map<string, Sprite>()

	constructor(opts?: {
		token?: string
		region?: string
		ramMB?: number
		cpus?: number
	}) {
		this.token = opts?.token ?? process.env.FLY_API_TOKEN ?? ""
		this.baseURL = "https://api.sprites.dev"
		this.client = new SpritesClient(this.token)
	}

	private getSprite(handle: SandboxHandle): Sprite {
		const sprite = this.sprites.get(handle.sessionId)
		if (!sprite) throw new Error(`No Sprites sandbox for session ${handle.sessionId}`)
		return sprite
	}

	/**
	 * Set network policy to allow all outbound connections.
	 * The JS SDK doesn't expose this yet, so we call the REST API directly.
	 */
	private async setNetworkPolicyAllowAll(spriteName: string): Promise<void> {
		const url = `${this.baseURL}/v1/sprites/${encodeURIComponent(spriteName)}/policy/network`
		const resp = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				rules: [{ domain: "*", action: "allow" }],
			}),
		})
		if (!resp.ok) {
			console.warn(`[sprites] Failed to set network policy (${resp.status}): ${await resp.text()}`)
		}
	}

	async create(sessionId: string, opts?: CreateSandboxOpts): Promise<SandboxHandle> {
		const infra: InfraConfig = opts?.infra ?? { mode: "local" }
		const projectName = opts?.projectName || sessionId.slice(0, 8)
		const spriteName = `ea-${sessionId.slice(0, 12)}`

		console.log(
			`[sprites] Creating sprite: session=${sessionId} project=${projectName} name=${spriteName} infra=${infra.mode}`,
		)

		// Create sprite with resource config
		const sprite = await this.client.createSprite(spriteName, {
			ramMB: DEFAULT_RAM_MB,
			cpus: DEFAULT_CPUS,
			region: DEFAULT_REGION,
		})

		// Enable outbound internet access
		await this.setNetworkPolicyAllowAll(spriteName)

		// Bootstrap (or restore from checkpoint)
		await ensureBootstrapped(sprite)

		// Set environment variables by writing an env file and sourcing it
		const envVars: Record<string, string> = {
			SANDBOX_MODE: "1",
			VITE_PORT: "5173",
		}

		const isCloud = infra.mode === "cloud" || infra.mode === "claim"
		if (isCloud) {
			envVars.DATABASE_URL = infra.databaseUrl
			envVars.ELECTRIC_URL = infra.electricUrl
			envVars.ELECTRIC_SOURCE_ID = infra.sourceId
			envVars.ELECTRIC_SECRET = infra.secret
		}

		if (opts?.apiKey) {
			envVars.ANTHROPIC_API_KEY = opts.apiKey
		}

		if (opts?.ghToken) {
			envVars.GH_TOKEN = opts.ghToken
		}

		// Pass stream env vars for hosted Durable Streams communication
		if (opts?.streamEnv) {
			for (const [key, value] of Object.entries(opts.streamEnv)) {
				envVars[key] = value
			}
		}

		// Write env vars to a profile file so all commands inherit them
		const envLines = Object.entries(envVars)
			.map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
			.join("\n")
		await sprite.exec(`cat > /etc/profile.d/electric-agent.sh << 'ENVEOF'\n${envLines}\nENVEOF`)
		// Also source into the current shell for immediate availability
		await sprite.exec(`bash -c 'source /etc/profile.d/electric-agent.sh'`)

		const projectDir = `/home/agent/workspace/${projectName}`
		await sprite.exec(`mkdir -p ${projectDir}`)

		// Get preview URL for port 5173
		// Sprites expose HTTP via https://{name}.sprites.dev by default on port 8080.
		// For other ports we use the proxy URL format.
		const previewUrl = `https://${spriteName}.sprites.dev`

		const handle: SandboxHandle = {
			sessionId,
			runtime: "sprites",
			port: 5173,
			projectDir,
			previewUrl,
		}

		this.handles.set(sessionId, handle)
		this.sprites.set(sessionId, sprite)

		// Agent is NOT started here — the bridge starts it
		console.log("[sprites] Sprite ready (agent will be started by bridge)")

		return handle
	}

	async destroy(handle: SandboxHandle): Promise<void> {
		const sprite = this.sprites.get(handle.sessionId)
		this.handles.delete(handle.sessionId)
		this.sprites.delete(handle.sessionId)

		if (sprite) {
			try {
				await sprite.delete()
			} catch {
				// Sprite may already be deleted
			}
		}
	}

	async restartAgent(handle: SandboxHandle): Promise<SandboxHandle> {
		const sprite = this.getSprite(handle)

		// Kill any running agent process — the bridge will restart it
		try {
			await sprite.exec("pkill -f 'electric-agent headless' || true")
		} catch {
			// Process may not be running
		}

		const newHandle: SandboxHandle = { ...handle }
		this.handles.set(handle.sessionId, newHandle)
		return newHandle
	}

	/** Get the underlying Sprite SDK object for bridge communication */
	getSpriteObject(sessionId: string): Sprite | undefined {
		return this.sprites.get(sessionId)
	}

	get(sessionId: string): SandboxHandle | undefined {
		return this.handles.get(sessionId)
	}

	list(): SandboxHandle[] {
		return [...this.handles.values()]
	}

	isAlive(handle: SandboxHandle): boolean {
		return this.sprites.has(handle.sessionId)
	}

	async exec(handle: SandboxHandle, command: string): Promise<string> {
		const sprite = this.getSprite(handle)
		const result = await sprite.exec(`source /etc/profile.d/electric-agent.sh && ${command}`)
		return (
			typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf-8")
		).trim()
	}

	async listFiles(handle: SandboxHandle, dir: string): Promise<string[]> {
		const sprite = this.sprites.get(handle.sessionId)
		if (!sprite) return []

		try {
			const result = await sprite.exec(
				`find ${dir} -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.next/*' -not -path '*/.cache/*' -not -path '*/.electric/*' -not -name 'pnpm-lock.yaml' -not -name 'package-lock.json'`,
			)
			const stdout =
				typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf-8")
			return stdout
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean)
		} catch {
			return []
		}
	}

	async readFile(handle: SandboxHandle, filePath: string): Promise<string | null> {
		const sprite = this.sprites.get(handle.sessionId)
		if (!sprite) return null

		try {
			const result = await sprite.exec(`cat ${filePath}`)
			return typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf-8")
		} catch {
			return null
		}
	}

	async startApp(handle: SandboxHandle): Promise<boolean> {
		try {
			await this.exec(handle, "cd /home/agent/workspace/*/ && pnpm dev:start")
			return true
		} catch {
			return false
		}
	}

	async stopApp(handle: SandboxHandle): Promise<boolean> {
		try {
			await this.exec(handle, "cd /home/agent/workspace/*/ && pnpm dev:stop")
			return true
		} catch {
			return false
		}
	}

	async isAppRunning(handle: SandboxHandle): Promise<boolean> {
		try {
			const result = await this.exec(
				handle,
				"kill -0 $(cat /tmp/dev-server.pid 2>/dev/null) 2>/dev/null && echo RUNNING || echo STOPPED",
			)
			return result.includes("RUNNING")
		} catch {
			return false
		}
	}

	async gitStatus(handle: SandboxHandle, projectDir: string): Promise<GitStatus> {
		const sprite = this.sprites.get(handle.sessionId)
		if (!sprite) {
			return {
				initialized: false,
				branch: null,
				hasUncommitted: false,
				lastCommitHash: null,
				lastCommitMessage: null,
			}
		}

		try {
			const initResult = await this.exec(
				handle,
				`cd ${projectDir} && test -d .git && echo "GIT_INIT=yes" || echo "GIT_INIT=no"`,
			)
			if (!initResult.includes("GIT_INIT=yes")) {
				return {
					initialized: false,
					branch: null,
					hasUncommitted: false,
					lastCommitHash: null,
					lastCommitMessage: null,
				}
			}

			const branch = (
				await this.exec(
					handle,
					`cd ${projectDir} && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""`,
				)
			).trim()
			const hash = (
				await this.exec(handle, `cd ${projectDir} && git rev-parse HEAD 2>/dev/null || echo ""`)
			).trim()
			const message = (
				await this.exec(handle, `cd ${projectDir} && git log -1 --format=%s 2>/dev/null || echo ""`)
			).trim()
			const statusOutput = (
				await this.exec(handle, `cd ${projectDir} && git status --porcelain 2>/dev/null || echo ""`)
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

	async getPreviewUrl(handle: SandboxHandle, _port: number): Promise<string | null> {
		return handle.previewUrl ?? null
	}

	async createFromRepo(
		sessionId: string,
		repoUrl: string,
		opts?: { branch?: string; apiKey?: string; ghToken?: string },
	): Promise<SandboxHandle> {
		const repoName =
			repoUrl
				.split("/")
				.pop()
				?.replace(/\.git$/, "") || "resumed-project"

		const handle = await this.create(sessionId, {
			apiKey: opts?.apiKey,
			ghToken: opts?.ghToken,
			projectName: repoName,
		})

		const targetDir = `/home/agent/workspace/${repoName}`
		await this.exec(
			handle,
			`gh repo clone "${repoUrl}" "${targetDir}" 2>/dev/null || git clone "${repoUrl}" "${targetDir}"`,
		)

		if (opts?.branch) {
			await this.exec(handle, `cd ${targetDir} && git checkout ${opts.branch}`)
		}

		handle.projectDir = targetDir
		return handle
	}
}
