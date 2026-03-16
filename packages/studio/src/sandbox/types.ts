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
	| { mode: "none" }
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
	/** Prod mode: install git credential helper that fetches tokens from studio server */
	prodMode?: {
		sessionToken: string
		studioUrl: string
	}
}

// ---------------------------------------------------------------------------
// Provider interface
//
// Communication (commands, gate responses) flows through SessionBridge,
// NOT through the sandbox provider. The provider is pure CRUD + operations.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared git credential helper script
//
// Reads EA_SESSION_TOKEN, EA_SESSION_ID, EA_STUDIO_URL from a dedicated env
// file (~/.git-credential-env) rather than hardcoding secrets in the script.
// Works in both Docker (non-login bash -c) and Sprites runtimes.
// ---------------------------------------------------------------------------

export const GIT_CREDENTIAL_ENV_PATH = "/home/agent/.git-credential-env"

export const GIT_CREDENTIAL_SCRIPT = `#!/bin/bash
# git-credential-electric: fetches GitHub tokens from studio server
if [ "$1" != "get" ]; then exit 0; fi

input=$(cat)
host=$(echo "$input" | grep "^host=" | cut -d= -f2)
if [ "$host" != "github.com" ]; then exit 0; fi

# Load credentials from env file (written during sandbox setup)
if [ -f "${GIT_CREDENTIAL_ENV_PATH}" ]; then
  set -a
  . "${GIT_CREDENTIAL_ENV_PATH}"
  set +a
fi

if [ -z "$EA_SESSION_TOKEN" ] || [ -z "$EA_SESSION_ID" ] || [ -z "$EA_STUDIO_URL" ]; then
  echo "git-credential-electric: missing EA_SESSION_TOKEN/EA_SESSION_ID/EA_STUDIO_URL" >&2
  exit 1
fi

response=$(curl -s -w "\\\\n%{http_code}" -X POST \\
  -H "Authorization: Bearer $EA_SESSION_TOKEN" \\
  "$EA_STUDIO_URL/api/sessions/$EA_SESSION_ID/github-token")

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
