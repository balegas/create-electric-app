import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitStatus {
	initialized: boolean
	branch: string | null
	remoteUrl: string | null
	hasUncommitted: boolean
	lastCommit: { hash: string; message: string; ts: string } | null
	repoName: string | null
}

export interface CheckpointResult {
	success: boolean
	commitHash: string | null
	message: string
	error?: string
}

export interface PublishResult {
	success: boolean
	repoUrl: string | null
	branch: string | null
	error?: string
}

export interface GhRepo {
	nameWithOwner: string
	url: string
	updatedAt: string
}

export interface GhBranch {
	name: string
	isDefault: boolean
}

export interface GhAccount {
	login: string
	type: "user" | "org"
}

export interface TokenValidation {
	valid: boolean
	username?: string
	error?: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function execGit(cwd: string, args: string[], env?: Record<string, string>): string {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			timeout: 30_000,
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		}).trim()
	} catch (e: unknown) {
		const stderr = (e as Record<string, string>)?.stderr || ""
		const stdout = (e as Record<string, string>)?.stdout || ""
		const detail = stderr || stdout || (e instanceof Error ? e.message : "git command failed")
		throw new Error(`git ${args.join(" ")}: ${detail}`)
	}
}

function execGh(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): string {
	try {
		return execFileSync("gh", args, {
			cwd: opts?.cwd,
			encoding: "utf-8",
			timeout: 30_000,
			env: { ...process.env, ...opts?.env },
			stdio: ["pipe", "pipe", "pipe"],
		}).trim()
	} catch (e: unknown) {
		const stderr = (e as Record<string, string>)?.stderr || ""
		const stdout = (e as Record<string, string>)?.stdout || ""
		const detail = stderr || stdout || (e instanceof Error ? e.message : "gh command failed")
		throw new Error(`gh ${args.join(" ")}: ${detail}`)
	}
}

function parseRepoName(remoteUrl: string | null): string | null {
	if (!remoteUrl) return null
	// Handle SSH: git@github.com:owner/repo.git
	const ssh = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/)
	if (ssh) return ssh[1]
	// Handle HTTPS: https://github.com/owner/repo.git
	const https = remoteUrl.match(/github\.com\/(.+?)(?:\.git)?$/)
	if (https) return https[1]
	return null
}

function generateCommitMessage(cwd: string): string {
	const status = execGit(cwd, ["status", "--porcelain"])
	const lines = status.split("\n").filter(Boolean)
	const added = lines.filter((l) => l.startsWith("A") || l.startsWith("?")).length
	const modified = lines.filter((l) => l.startsWith(" M") || l.startsWith("M")).length
	const deleted = lines.filter((l) => l.startsWith(" D") || l.startsWith("D")).length
	const parts: string[] = []
	if (added) parts.push(`+${added}`)
	if (modified) parts.push(`~${modified}`)
	if (deleted) parts.push(`-${deleted}`)
	const summary = parts.length > 0 ? `${parts.join(" ")} files` : "no changes"
	return `checkpoint: ${summary} [${new Date().toISOString().slice(0, 10)}]`
}

function ensureGitIdentity(cwd: string): void {
	try {
		execGit(cwd, ["config", "user.email"])
	} catch {
		execGit(cwd, ["config", "user.email", "electric-agent@local"])
		execGit(cwd, ["config", "user.name", "Electric Agent"])
	}
}

// ---------------------------------------------------------------------------
// Public API — Local Git
// ---------------------------------------------------------------------------

/**
 * Initialize a git repo with an initial commit.
 * Called by scaffold after project setup.
 */
export function gitInit(projectDir: string, projectName?: string): string {
	execGit(projectDir, ["init", "-b", "main"])
	ensureGitIdentity(projectDir)
	execGit(projectDir, ["add", "-A"])
	return execGit(projectDir, ["commit", "-m", `chore: scaffold ${projectName ?? "project"}`])
}

/**
 * Checkout an existing branch or create a new one.
 */
export function gitCheckoutBranch(projectDir: string, branch: string): void {
	try {
		// Try checking out existing branch
		execGit(projectDir, ["checkout", branch])
	} catch {
		// Branch doesn't exist locally — create it
		execGit(projectDir, ["checkout", "-b", branch])
	}
}

/**
 * Get the current git status of a project directory.
 */
export function gitStatus(projectDir: string): GitStatus {
	const gitDir = path.join(projectDir, ".git")
	if (!fs.existsSync(gitDir)) {
		return {
			initialized: false,
			branch: null,
			remoteUrl: null,
			hasUncommitted: false,
			lastCommit: null,
			repoName: null,
		}
	}

	let branch: string | null = null
	try {
		branch = execGit(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"])
	} catch {
		// detached HEAD or empty repo
	}

	let remoteUrl: string | null = null
	try {
		remoteUrl = execGit(projectDir, ["remote", "get-url", "origin"])
	} catch {
		// no remote configured
	}

	let hasUncommitted = false
	try {
		const status = execGit(projectDir, ["status", "--porcelain"])
		hasUncommitted = status.length > 0
	} catch {
		// ignore
	}

	let lastCommit: GitStatus["lastCommit"] = null
	try {
		const log = execGit(projectDir, ["log", "-1", "--format=%H%n%s%n%aI"])
		const [hash, message, ts] = log.split("\n")
		if (hash && message && ts) {
			lastCommit = { hash, message, ts }
		}
	} catch {
		// empty repo
	}

	return {
		initialized: true,
		branch,
		remoteUrl,
		hasUncommitted,
		lastCommit,
		repoName: parseRepoName(remoteUrl),
	}
}

/**
 * Create a checkpoint commit with all current changes.
 */
export function gitCheckpoint(projectDir: string, message?: string): CheckpointResult {
	const status = gitStatus(projectDir)
	if (!status.initialized) {
		return { success: false, commitHash: null, message: "", error: "Not a git repository" }
	}

	if (!status.hasUncommitted) {
		return {
			success: true,
			commitHash: status.lastCommit?.hash ?? null,
			message: "No changes to commit",
		}
	}

	const commitMsg = message || generateCommitMessage(projectDir)

	try {
		ensureGitIdentity(projectDir)
		execGit(projectDir, ["add", "-A"])
		execGit(projectDir, ["commit", "-m", commitMsg])
		const hash = execGit(projectDir, ["rev-parse", "HEAD"])
		return { success: true, commitHash: hash, message: commitMsg }
	} catch (e) {
		return {
			success: false,
			commitHash: null,
			message: commitMsg,
			error: e instanceof Error ? e.message : "Commit failed",
		}
	}
}

// ---------------------------------------------------------------------------
// Public API — GitHub (via gh CLI)
// ---------------------------------------------------------------------------

/**
 * Validate a GitHub PAT by logging in and checking auth status.
 * Required scopes: repo, read:user
 */
export function validateGhToken(token: string): TokenValidation {
	try {
		// Login with the token via stdin
		execFileSync("gh", ["auth", "login", "--with-token"], {
			input: token,
			encoding: "utf-8",
			timeout: 15_000,
			env: { ...process.env, GH_TOKEN: undefined },
			stdio: ["pipe", "pipe", "pipe"],
		})

		// Check auth status
		const statusOutput = execGh(["auth", "status"])

		// Extract username from status output
		const userMatch =
			statusOutput.match(/Logged in to github\.com account (\S+)/) ||
			statusOutput.match(/Logged in to github\.com as (\S+)/)
		const username = userMatch?.[1] ?? "unknown"

		return { valid: true, username }
	} catch (e) {
		// Clean up on failure
		try {
			execGh(["auth", "logout", "--hostname", "github.com"])
		} catch {
			// ignore cleanup failures
		}
		return {
			valid: false,
			error: e instanceof Error ? e.message : "Token validation failed",
		}
	}
}

/**
 * Publish a local project to a new GitHub repo.
 * Creates a feature branch and pushes.
 * If a token is provided, it is used instead of the ambient GH_TOKEN.
 */
export function ghPublish(
	projectDir: string,
	repoName: string,
	opts?: { visibility?: "public" | "private"; token?: string },
): PublishResult {
	const visibility = opts?.visibility ?? "private"
	const ghOpts: { cwd: string; env?: Record<string, string> } = { cwd: projectDir }
	if (opts?.token) ghOpts.env = { GH_TOKEN: opts.token }

	try {
		// Checkpoint any uncommitted changes first
		const status = gitStatus(projectDir)
		if (status.hasUncommitted) {
			gitCheckpoint(projectDir, "checkpoint before publish")
		}

		// Create feature branch if on main
		const currentBranch = execGit(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"])
		let targetBranch = currentBranch
		if (currentBranch === "main") {
			const branchName = `electric-agent/${path.basename(projectDir)}`
			execGit(projectDir, ["checkout", "-b", branchName])
			targetBranch = branchName
		}

		// Create repo and push
		const output = execGh(
			[
				"repo",
				"create",
				repoName,
				`--${visibility}`,
				"--source",
				".",
				"--remote",
				"origin",
				"--push",
			],
			ghOpts,
		)

		// Extract repo URL from output
		const urlMatch = output.match(/(https:\/\/github\.com\/\S+)/)
		const repoUrl = urlMatch?.[1] ?? `https://github.com/${repoName}`

		return { success: true, repoUrl, branch: targetBranch }
	} catch (e) {
		return {
			success: false,
			repoUrl: null,
			branch: null,
			error: e instanceof Error ? e.message : "Publish failed",
		}
	}
}

/**
 * Create a PR from the current branch to the default branch.
 * If a token is provided, it is used instead of the ambient GH_TOKEN.
 */
export function ghPrCreate(
	projectDir: string,
	title?: string,
	body?: string,
	token?: string,
): { prUrl: string | null; error?: string } {
	const ghOpts: { cwd: string; env?: Record<string, string> } = { cwd: projectDir }
	if (token) ghOpts.env = { GH_TOKEN: token }

	try {
		const branch = execGit(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"])
		const prTitle = title || `[electric-agent] ${branch}`
		const prBody =
			body || "Generated by electric-agent.\n\nReview the changes and merge when ready."

		// Push current branch first
		execGit(projectDir, ["push", "-u", "origin", branch])

		const output = execGh(["pr", "create", "--title", prTitle, "--body", prBody], ghOpts)

		// Extract PR URL from output
		const urlMatch = output.match(/(https:\/\/github\.com\/\S+\/pull\/\d+)/)
		return { prUrl: urlMatch?.[1] ?? output }
	} catch (e) {
		return {
			prUrl: null,
			error: e instanceof Error ? e.message : "PR creation failed",
		}
	}
}

/**
 * List the authenticated user's personal account + organizations.
 * If a token is provided, it is used instead of the ambient GH_TOKEN.
 */
export function ghListAccounts(token?: string): GhAccount[] {
	const ghOpts = token ? { env: { GH_TOKEN: token } } : undefined
	const accounts: GhAccount[] = []
	try {
		// Get the authenticated user's login
		const username = execGh(["api", "/user", "--jq", ".login"], ghOpts)
		if (username) {
			accounts.push({ login: username, type: "user" })
		}
	} catch {
		// ignore
	}
	try {
		// Get organizations the user belongs to
		const output = execGh(["api", "/user/orgs", "--jq", "[.[] | .login]"], ghOpts)
		const orgs = JSON.parse(output) as string[]
		for (const org of orgs) {
			accounts.push({ login: org, type: "org" })
		}
	} catch {
		// ignore
	}
	return accounts
}

/**
 * List the authenticated user's GitHub repos.
 * If a token is provided, it is used instead of the ambient GH_TOKEN.
 */
export function ghListRepos(limit = 50, token?: string): GhRepo[] {
	const ghOpts = token ? { env: { GH_TOKEN: token } } : undefined
	try {
		// Use /user/repos API to get ALL repos the token has access to
		// (owned, collaborator, and org member), not just owned repos.
		const output = execGh(
			[
				"api",
				`/user/repos?sort=updated&per_page=${limit}&affiliation=owner,collaborator,organization_member`,
				"--jq",
				`[.[] | {nameWithOwner: .full_name, url: .html_url, updatedAt: .updated_at}]`,
			],
			ghOpts,
		)
		return JSON.parse(output) as GhRepo[]
	} catch {
		// Fallback to gh repo list (only owned repos)
		try {
			const output = execGh(
				[
					"repo",
					"list",
					"--json",
					"nameWithOwner,url,updatedAt",
					"--limit",
					String(limit),
					"--sort",
					"updated",
				],
				ghOpts,
			)
			return JSON.parse(output) as GhRepo[]
		} catch {
			return []
		}
	}
}

/**
 * List branches for a GitHub repo.
 * If a token is provided, it is used instead of the ambient GH_TOKEN.
 */
export function ghListBranches(repoFullName: string, token?: string): GhBranch[] {
	const ghOpts = token ? { env: { GH_TOKEN: token } } : undefined
	try {
		// Get the default branch name
		const defaultBranch = execGh(
			["api", `/repos/${repoFullName}`, "--jq", ".default_branch"],
			ghOpts,
		)

		// Get all branches
		const output = execGh(
			["api", `/repos/${repoFullName}/branches?per_page=100`, "--jq", `[.[] | {name: .name}]`],
			ghOpts,
		)
		const branches = JSON.parse(output) as { name: string }[]
		return branches.map((b) => ({
			name: b.name,
			isDefault: b.name === defaultBranch,
		}))
	} catch {
		return []
	}
}

/**
 * Clone a GitHub repo into a target directory.
 * If a token is provided, it is used instead of the ambient GH_TOKEN.
 */
export function ghClone(repoUrl: string, targetDir: string, branch?: string, token?: string): void {
	const args = ["repo", "clone", repoUrl, targetDir]
	if (branch) {
		args.push("--", "-b", branch)
	}
	execGh(args, token ? { env: { GH_TOKEN: token } } : undefined)
}

/**
 * Check if gh CLI is available and authenticated.
 * If a token is provided, it is used instead of the ambient GH_TOKEN.
 */
export function isGhAuthenticated(token?: string): boolean {
	try {
		execGh(["auth", "status"], token ? { env: { GH_TOKEN: token } } : undefined)
		return true
	} catch {
		return false
	}
}

/**
 * Push the current branch to origin.
 */
export function gitPush(projectDir: string): { success: boolean; error?: string } {
	try {
		const branch = execGit(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"])
		execGit(projectDir, ["push", "-u", "origin", branch])
		return { success: true }
	} catch (e) {
		return { success: false, error: e instanceof Error ? e.message : "Push failed" }
	}
}
