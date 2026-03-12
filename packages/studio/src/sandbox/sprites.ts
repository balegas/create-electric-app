import { type Sprite, SpritesClient } from "@fly/sprites"
import { ensureBootstrapped } from "./sprites-bootstrap.js"
import type {
	CreateSandboxOpts,
	GitStatus,
	InfraConfig,
	SandboxHandle,
	SandboxProvider,
} from "./types.js"

/** Shell-quote a string for safe interpolation in bash commands. */
function shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`
}

/** Validate a name contains only safe characters (alphanumeric, hyphens, underscores, dots). */
function validateName(name: string, label: string): void {
	if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
		throw new Error(
			`Invalid ${label}: must contain only alphanumeric chars, hyphens, underscores, and dots`,
		)
	}
}

/** Validate a git branch name (no shell metacharacters, spaces, or control chars). */
function validateBranchName(branch: string): void {
	if (!/^[a-zA-Z0-9._\-/]+$/.test(branch)) {
		throw new Error(
			"Invalid branch name: must contain only alphanumeric chars, hyphens, underscores, dots, and slashes",
		)
	}
}

/** Validate a repo URL (must be https:// or git@ protocol, no shell metacharacters). */
function validateRepoUrl(url: string): void {
	if (!/^(https?:\/\/[^\s'"`;|&$()]+|git@[^\s'"`;|&$():]+:[^\s'"`;|&$()]+)$/.test(url)) {
		throw new Error("Invalid repo URL: must be a valid https:// or git@ URL")
	}
}

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
	 * Fetch the public URL for a sprite from the REST API.
	 * The URL includes an org slug suffix that we can't derive locally.
	 */
	private async getSpriteUrl(spriteName: string): Promise<string | null> {
		const url = `${this.baseURL}/v1/sprites/${encodeURIComponent(spriteName)}`
		const resp = await fetch(url, {
			headers: { Authorization: `Bearer ${this.token}` },
		})
		if (!resp.ok) {
			console.warn(`[sprites] Failed to get sprite info (${resp.status}): ${await resp.text()}`)
			return null
		}
		const data = (await resp.json()) as { url?: string }
		return data.url ?? null
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

	/**
	 * Set the sprite URL to public access (no login required).
	 * By default sprites require authentication to access their URL.
	 */
	private async setUrlPublic(spriteName: string): Promise<void> {
		const url = `${this.baseURL}/v1/sprites/${encodeURIComponent(spriteName)}`
		const resp = await fetch(url, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				url_settings: { auth: "public" },
			}),
		})
		if (!resp.ok) {
			console.warn(`[sprites] Failed to set URL to public (${resp.status}): ${await resp.text()}`)
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

		// Enable outbound internet access and public URL access (no login page)
		await Promise.all([this.setNetworkPolicyAllowAll(spriteName), this.setUrlPublic(spriteName)])

		// Bootstrap (or restore from checkpoint).
		// When AGENT_PACKAGE_URL is set (e.g. PR preview), install from that URL
		// instead of the published electric-agent package.
		const packageUrl = process.env.AGENT_PACKAGE_URL || undefined
		await ensureBootstrapped(sprite, packageUrl ? { packageUrl } : undefined)

		// Set environment variables by writing an env file and sourcing it
		const envVars: Record<string, string> = {
			SANDBOX_MODE: "1",
			VITE_PORT: "8080",
		}

		const isCloud = infra.mode === "cloud" || infra.mode === "claim"
		if (isCloud) {
			envVars.DATABASE_URL = infra.databaseUrl
			envVars.ELECTRIC_URL = infra.electricUrl
			envVars.ELECTRIC_SOURCE_ID = infra.sourceId
			envVars.ELECTRIC_SECRET = infra.secret
		}

		if (opts?.oauthToken) {
			envVars.CLAUDE_CODE_OAUTH_TOKEN = opts.oauthToken
		} else if (opts?.apiKey) {
			envVars.ANTHROPIC_API_KEY = opts.apiKey
		}

		if (opts?.ghToken) {
			envVars.GH_TOKEN = opts.ghToken
		}

		// Write env vars to a profile file so all commands inherit them.
		// NOTE: sprite.exec() splits the command string by whitespace, so shell
		// features (pipes, redirects, heredocs) don't work. Use execFile with
		// explicit args to run through bash -c instead.
		const envLines = Object.entries(envVars)
			.map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
			.join("\n")
		const b64 = Buffer.from(envLines).toString("base64")
		await sprite.execFile("bash", [
			"-c",
			`echo ${b64} | base64 -d > /etc/profile.d/electric-agent.sh`,
		])

		// In prod mode, install git credential helper that fetches tokens from studio server
		if (opts?.prodMode) {
			await this.installCredentialHelper(
				sprite,
				sessionId,
				opts.prodMode.sessionToken,
				opts.prodMode.studioUrl,
			)
		}

		validateName(projectName, "project name")
		const projectDir = `/home/agent/workspace/${projectName}`
		await sprite.execFile("mkdir", ["-p", projectDir])

		// Fetch the public URL from the API — it includes the org slug suffix.
		// Sprites route this URL to port 8080 by default; VITE_PORT is set to 8080 above.
		const previewUrl = await this.getSpriteUrl(spriteName)

		const handle: SandboxHandle = {
			sessionId,
			runtime: "sprites",
			port: 8080,
			projectDir,
			previewUrl: previewUrl ?? undefined,
		}

		this.handles.set(sessionId, handle)
		this.sprites.set(sessionId, sprite)

		// Agent is NOT started here — the bridge starts it
		console.log("[sprites] Sprite ready (agent will be started by bridge)")

		return handle
	}

	private async installCredentialHelper(
		sprite: Sprite,
		sessionId: string,
		sessionToken: string,
		studioUrl: string,
	): Promise<void> {
		const script = `#!/bin/bash
# git-credential-electric: fetches GitHub tokens from studio server
if [ "$1" != "get" ]; then exit 0; fi

input=$(cat)
host=$(echo "$input" | grep "^host=" | cut -d= -f2)
if [ "$host" != "github.com" ]; then exit 0; fi

response=$(curl -s -w "\\n%{http_code}" -X POST \\
  -H "Authorization: Bearer \${SESSION_TOKEN}" \\
  "\${STUDIO_URL}/api/sessions/\${SESSION_ID}/github-token")

http_code=$(echo "$response" | tail -1)
body_text=$(echo "$response" | sed '\\$d')

if [ "$http_code" != "200" ]; then
  echo "git-credential-electric: failed to fetch token (HTTP $http_code)" >&2
  exit 1
fi

token=$(echo "$body_text" | jq -r '.token')
if [ -n "$token" ] && [ "$token" != "null" ]; then
  echo "protocol=https"
  echo "host=github.com"
  echo "username=x-access-token"
  echo "password=\${token}"
else
  echo "git-credential-electric: invalid token response" >&2
  exit 1
fi`

		// Write credential helper script
		const scriptB64 = Buffer.from(script).toString("base64")
		await sprite.execFile("bash", [
			"-c",
			`echo ${scriptB64} | base64 -d > /usr/local/bin/git-credential-electric && chmod +x /usr/local/bin/git-credential-electric`,
		])

		// Append session env vars for the credential helper
		const envScript = [
			`export SESSION_TOKEN="${sessionToken}"`,
			`export SESSION_ID="${sessionId}"`,
			`export STUDIO_URL="${studioUrl}"`,
		].join("\n")
		const envB64 = Buffer.from(envScript).toString("base64")
		await sprite.execFile("bash", [
			"-c",
			`echo ${envB64} | base64 -d >> /etc/profile.d/electric-agent.sh`,
		])

		// Override the default gh credential helper set during bootstrap
		await sprite.execFile("git", [
			"config",
			"--global",
			"credential.helper",
			"electric",
		])

		console.log(`[sprites] Credential helper installed for session ${sessionId}`)
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
		const result = await sprite.execFile("bash", [
			"-c",
			`source /etc/profile.d/npm-global.sh 2>/dev/null; source /etc/profile.d/electric-agent.sh && ${command}`,
		])
		return (
			typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf-8")
		).trim()
	}

	async listFiles(handle: SandboxHandle, dir: string): Promise<string[]> {
		const sprite = this.sprites.get(handle.sessionId)
		if (!sprite) return []

		try {
			const result = await sprite.execFile("bash", [
				"-c",
				`find ${shellQuote(dir)} -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.next/*' -not -path '*/.cache/*' -not -path '*/.electric/*' -not -name 'pnpm-lock.yaml' -not -name 'package-lock.json'`,
			])
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
			const result = await sprite.execFile("cat", [filePath])
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
			const qDir = shellQuote(projectDir)
			const initResult = await this.exec(
				handle,
				`cd ${qDir} && test -d .git && echo "GIT_INIT=yes" || echo "GIT_INIT=no"`,
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
					`cd ${qDir} && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""`,
				)
			).trim()
			const hash = (
				await this.exec(handle, `cd ${qDir} && git rev-parse HEAD 2>/dev/null || echo ""`)
			).trim()
			const message = (
				await this.exec(handle, `cd ${qDir} && git log -1 --format=%s 2>/dev/null || echo ""`)
			).trim()
			const statusOutput = (
				await this.exec(handle, `cd ${qDir} && git status --porcelain 2>/dev/null || echo ""`)
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
		opts?: { branch?: string; apiKey?: string; oauthToken?: string; ghToken?: string },
	): Promise<SandboxHandle> {
		validateRepoUrl(repoUrl)
		if (opts?.branch) {
			validateBranchName(opts.branch)
		}

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

		const targetDir = `/home/agent/workspace/${repoName}`
		const qUrl = shellQuote(repoUrl)
		const qDir = shellQuote(targetDir)
		await this.exec(
			handle,
			`gh repo clone ${qUrl} ${qDir} 2>/dev/null || git clone ${qUrl} ${qDir}`,
		)

		if (opts?.branch) {
			await this.exec(handle, `cd ${qDir} && git checkout ${shellQuote(opts.branch)}`)
		}

		handle.projectDir = targetDir
		return handle
	}
}
