// ---------------------------------------------------------------------------
// Sandbox handle — returned by create/restartAgent
// ---------------------------------------------------------------------------

export type SandboxRuntime = "docker" | "sprites"

export interface SandboxHandle {
	sessionId: string
	runtime: SandboxRuntime
	port: number
	projectDir: string
	/** Preview URL for cloud runtimes (Sprites) */
	previewUrl?: string
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface GitStatus {
	initialized: boolean
	branch: string | null
	hasUncommitted: boolean
	lastCommitHash: string | null
	lastCommitMessage: string | null
}

// ---------------------------------------------------------------------------
// Infrastructure configuration
// ---------------------------------------------------------------------------

export type InfraConfig =
	| { mode: "local" }
	| {
			mode: "cloud"
			databaseUrl: string
			electricUrl: string
			sourceId: string
			secret: string
	  }
	| {
			mode: "claim"
			databaseUrl: string
			electricUrl: string
			sourceId: string
			secret: string
			claimId: string
	  }

// ---------------------------------------------------------------------------
// Create options
// ---------------------------------------------------------------------------

export interface CreateSandboxOpts {
	apiKey?: string
	oauthToken?: string
	ghToken?: string
	projectName?: string
	infra?: InfraConfig
}

// ---------------------------------------------------------------------------
// Provider interface
//
// Communication (commands, gate responses) flows through SessionBridge,
// NOT through the sandbox provider. The provider is pure CRUD + operations.
// ---------------------------------------------------------------------------

export interface SandboxProvider {
	/** The runtime type this provider manages */
	readonly runtime: SandboxRuntime

	// Lifecycle
	create(sessionId: string, opts?: CreateSandboxOpts): Promise<SandboxHandle>
	destroy(handle: SandboxHandle): Promise<void>
	get(sessionId: string): SandboxHandle | undefined
	list(): SandboxHandle[]

	/** Check if the sandbox is still alive and responsive */
	isAlive(handle: SandboxHandle): boolean

	// File access
	listFiles(handle: SandboxHandle, dir: string): Promise<string[]>
	readFile(handle: SandboxHandle, filePath: string): Promise<string | null>

	// App lifecycle
	startApp(handle: SandboxHandle): Promise<boolean>
	stopApp(handle: SandboxHandle): Promise<boolean>
	isAppRunning(handle: SandboxHandle): Promise<boolean>

	// Execute a shell command inside the sandbox
	exec(handle: SandboxHandle, command: string): Promise<string>

	// Git (read-only — mutations go through the git agent inside the container)
	gitStatus(handle: SandboxHandle, projectDir: string): Promise<GitStatus>

	/** Get a preview URL for a port (cloud runtimes only) */
	getPreviewUrl?(handle: SandboxHandle, port: number): Promise<string | null>

	// Resume from repo
	createFromRepo(
		sessionId: string,
		repoUrl: string,
		opts?: { branch?: string; apiKey?: string; oauthToken?: string; ghToken?: string },
	): Promise<SandboxHandle>
}
