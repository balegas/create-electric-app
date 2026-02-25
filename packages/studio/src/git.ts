import { execFileSync } from "node:child_process"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List the authenticated user's personal account + organizations.
 */
export function ghListAccounts(token?: string): GhAccount[] {
	const ghOpts = token ? { env: { GH_TOKEN: token } } : undefined
	const accounts: GhAccount[] = []
	try {
		const username = execGh(["api", "/user", "--jq", ".login"], ghOpts)
		if (username) {
			accounts.push({ login: username, type: "user" })
		}
	} catch {
		// ignore
	}
	try {
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
 */
export function ghListRepos(limit = 50, token?: string): GhRepo[] {
	const ghOpts = token ? { env: { GH_TOKEN: token } } : undefined
	try {
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
 */
export function ghListBranches(repoFullName: string, token?: string): GhBranch[] {
	const ghOpts = token ? { env: { GH_TOKEN: token } } : undefined
	try {
		const defaultBranch = execGh(
			["api", `/repos/${repoFullName}`, "--jq", ".default_branch"],
			ghOpts,
		)
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
 * Check if gh CLI is available and authenticated.
 */
export function isGhAuthenticated(token?: string): boolean {
	try {
		execGh(["auth", "status"], token ? { env: { GH_TOKEN: token } } : undefined)
		return true
	} catch {
		return false
	}
}
