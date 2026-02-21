import { execSync } from "node:child_process"
import { tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

function exec(cmd: string, cwd: string, timeout = 30_000): string {
	try {
		return execSync(cmd, {
			encoding: "utf-8",
			timeout,
			cwd,
			env: { ...process.env },
			stdio: ["pipe", "pipe", "pipe"],
		}).trim()
	} catch (e: unknown) {
		const stderr = (e as Record<string, string>)?.stderr || ""
		const stdout = (e as Record<string, string>)?.stdout || ""
		throw new Error(stderr || stdout || (e instanceof Error ? e.message : "Command failed"))
	}
}

function jsonResult(data: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data) }],
	}
}

export function createGitStatusTool(projectDir: string) {
	return tool(
		"git_status",
		"Run git status --porcelain and git log -1 to see current state",
		{},
		async () => {
			try {
				const porcelain = exec("git status --porcelain", projectDir)
				const log = exec(
					"git log -1 --format=%H%n%s%n%aI 2>/dev/null || echo 'no commits'",
					projectDir,
				)
				const branch = exec(
					"git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown'",
					projectDir,
				)
				return jsonResult({ branch, status: porcelain || "(clean)", lastCommit: log })
			} catch (e) {
				return jsonResult({ error: e instanceof Error ? e.message : "git status failed" })
			}
		},
	)
}

export function createGitDiffSummaryTool(projectDir: string) {
	return tool(
		"git_diff_summary",
		"Run git diff --stat (or --cached --stat) to see a summary of changes",
		{ cached: z.boolean().optional().describe("If true, show staged changes only") },
		async ({ cached }) => {
			try {
				const flag = cached ? "--cached " : ""
				const stat = exec(`git diff ${flag}--stat`, projectDir)
				const shortstat = exec(`git diff ${flag}--shortstat`, projectDir)
				return jsonResult({ stat: stat || "(no changes)", shortstat: shortstat || "(no changes)" })
			} catch (e) {
				return jsonResult({ error: e instanceof Error ? e.message : "git diff --stat failed" })
			}
		},
	)
}

export function createGitDiffTool(projectDir: string) {
	return tool(
		"git_diff",
		"Run git diff to see full diff (optionally for specific files)",
		{ files: z.string().optional().describe("Space-separated file paths to diff") },
		async ({ files }) => {
			try {
				const cmd = files ? `git diff -- ${files}` : "git diff"
				const diff = exec(cmd, projectDir)
				// Truncate very large diffs
				const truncated = diff.length > 10_000 ? `${diff.slice(0, 10_000)}\n...(truncated)` : diff
				return jsonResult({ diff: truncated || "(no changes)" })
			} catch (e) {
				return jsonResult({ error: e instanceof Error ? e.message : "git diff failed" })
			}
		},
	)
}

export function createGitCommitTool(projectDir: string) {
	return tool(
		"git_commit",
		"Stage all changes and commit with the given message",
		{ message: z.string().describe("Commit message") },
		async ({ message }) => {
			try {
				exec("git add -A", projectDir)
				// Check if there are changes to commit
				try {
					exec("git diff --cached --quiet", projectDir)
					return jsonResult({ success: false, error: "No changes to commit" })
				} catch {
					// There are staged changes — proceed
				}
				exec(
					`git config user.email "agent@electric-sql.com" && git config user.name "Electric Agent"`,
					projectDir,
				)
				const safeMsg = message.replace(/"/g, '\\"')
				exec(`git commit -m "${safeMsg}"`, projectDir)
				const hash = exec("git rev-parse HEAD", projectDir)
				return jsonResult({ success: true, commitHash: hash, message })
			} catch (e) {
				return jsonResult({
					success: false,
					error: e instanceof Error ? e.message : "Commit failed",
				})
			}
		},
	)
}

export function createGitInitTool(projectDir: string) {
	return tool(
		"git_init",
		"Initialize a git repo with an initial commit",
		{ message: z.string().optional().describe("Initial commit message") },
		async ({ message }) => {
			try {
				exec("git init -b main", projectDir)
				exec(
					`git config user.email "agent@electric-sql.com" && git config user.name "Electric Agent"`,
					projectDir,
				)
				exec("git add -A", projectDir)
				const commitMsg = message || "chore: initial commit"
				const safeMsg = commitMsg.replace(/"/g, '\\"')
				exec(`git commit -m "${safeMsg}"`, projectDir)
				const hash = exec("git rev-parse HEAD", projectDir)
				return jsonResult({ success: true, commitHash: hash, message: commitMsg })
			} catch (e) {
				return jsonResult({
					success: false,
					error: e instanceof Error ? e.message : "git init failed",
				})
			}
		},
	)
}

export function createGitPushTool(projectDir: string) {
	return tool(
		"git_push",
		"Push the current branch to the remote",
		{ branch: z.string().optional().describe("Branch to push (defaults to current branch)") },
		async ({ branch }) => {
			try {
				const targetBranch = branch || exec("git rev-parse --abbrev-ref HEAD", projectDir)
				const output = exec(`git push -u origin ${targetBranch}`, projectDir, 60_000)
				return jsonResult({ success: true, branch: targetBranch, output })
			} catch (e) {
				return jsonResult({ success: false, error: e instanceof Error ? e.message : "Push failed" })
			}
		},
	)
}

export function createGhRepoCreateTool(projectDir: string) {
	return tool(
		"gh_repo_create",
		"Create a new GitHub repo from the current project and push",
		{
			name: z.string().describe("Repository name (e.g. 'my-app' or 'org/my-app')"),
			visibility: z
				.enum(["public", "private"])
				.optional()
				.describe("Repository visibility (default: private)"),
		},
		async ({ name, visibility }) => {
			try {
				const vis = visibility || "private"
				const output = exec(
					`gh repo create "${name}" --${vis} --source . --remote origin --push`,
					projectDir,
					60_000,
				)
				const urlMatch = output.match(/(https:\/\/github\.com\/\S+)/)
				const repoUrl = urlMatch?.[1] ?? `https://github.com/${name}`
				return jsonResult({ success: true, repoUrl, output })
			} catch (e) {
				return jsonResult({
					success: false,
					error: e instanceof Error ? e.message : "Repo creation failed",
				})
			}
		},
	)
}

export function createGhPrCreateTool(projectDir: string) {
	return tool(
		"gh_pr_create",
		"Create a pull request on GitHub",
		{
			title: z.string().describe("PR title"),
			body: z.string().optional().describe("PR body/description"),
		},
		async ({ title, body }) => {
			try {
				const prBody =
					body || "Generated by electric-agent.\n\nReview the changes and merge when ready."
				const safeTitle = title.replace(/"/g, '\\"')
				const safeBody = prBody.replace(/"/g, '\\"')
				const output = exec(
					`gh pr create --title "${safeTitle}" --body "${safeBody}"`,
					projectDir,
					30_000,
				)
				const urlMatch = output.match(/(https:\/\/github\.com\/\S+\/pull\/\d+)/)
				return jsonResult({ success: true, prUrl: urlMatch?.[1] ?? output })
			} catch (e) {
				return jsonResult({
					success: false,
					error: e instanceof Error ? e.message : "PR creation failed",
				})
			}
		},
	)
}

export function createGitCheckoutTool(projectDir: string) {
	return tool(
		"git_checkout",
		"Checkout an existing branch or create a new one",
		{
			branch: z.string().describe("Branch name"),
			create: z.boolean().optional().describe("Create the branch if it doesn't exist"),
		},
		async ({ branch, create }) => {
			try {
				const flag = create ? "-b " : ""
				const output = exec(`git checkout ${flag}${branch}`, projectDir)
				return jsonResult({ success: true, branch, output })
			} catch (e) {
				return jsonResult({
					success: false,
					error: e instanceof Error ? e.message : "Checkout failed",
				})
			}
		},
	)
}
