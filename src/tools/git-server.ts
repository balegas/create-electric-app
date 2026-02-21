import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import {
	createGhPrCreateTool,
	createGhRepoCreateTool,
	createGitCheckoutTool,
	createGitCommitTool,
	createGitDiffSummaryTool,
	createGitDiffTool,
	createGitInitTool,
	createGitPushTool,
	createGitStatusTool,
} from "./git.js"

export function createGitToolServer(projectDir: string) {
	return createSdkMcpServer({
		name: "git-tools",
		version: "1.0.0",
		tools: [
			createGitStatusTool(projectDir),
			createGitDiffSummaryTool(projectDir),
			createGitDiffTool(projectDir),
			createGitCommitTool(projectDir),
			createGitInitTool(projectDir),
			createGitPushTool(projectDir),
			createGhRepoCreateTool(projectDir),
			createGhPrCreateTool(projectDir),
			createGitCheckoutTool(projectDir),
		],
	})
}
