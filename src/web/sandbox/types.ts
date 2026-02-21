import type { ChildProcess } from "node:child_process"

// ---------------------------------------------------------------------------
// Sandbox handle — returned by create/restartAgent
// ---------------------------------------------------------------------------

export interface SandboxHandle {
	sessionId: string
	process: ChildProcess
	port: number
	projectDir: string
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

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface SandboxProvider {
	// Lifecycle
	create(
		sessionId: string,
		opts?: { apiKey?: string; projectName?: string; infra?: InfraConfig },
	): Promise<SandboxHandle>
	destroy(handle: SandboxHandle): void
	restartAgent(sessionId: string): Promise<SandboxHandle>
	get(sessionId: string): SandboxHandle | undefined

	// Communication (NDJSON protocol)
	sendCommand(handle: SandboxHandle, config: Record<string, unknown>): void
	sendGateResponse(handle: SandboxHandle, gate: string, value: Record<string, unknown>): void

	// File access
	listFiles(handle: SandboxHandle, dir: string): string[]
	readFile(handle: SandboxHandle, filePath: string): string | null

	// App lifecycle
	startApp(handle: SandboxHandle): Promise<boolean>
	stopApp(handle: SandboxHandle): Promise<boolean>
	isAppRunning(handle: SandboxHandle): boolean

	// Execute a shell command inside the container
	exec(handle: SandboxHandle, command: string): string

	// Git (read-only — mutations go through the git agent inside the container)
	gitStatus(handle: SandboxHandle, projectDir: string): GitStatus

	// Resume from repo
	createFromRepo(
		sessionId: string,
		repoUrl: string,
		opts?: { branch?: string; apiKey?: string },
	): Promise<SandboxHandle>
}
