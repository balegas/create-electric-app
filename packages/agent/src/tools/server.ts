import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import type { ProgressReporter } from "../progress/reporter.js"
import { createBuildTool } from "./build.js"
import { createPlaybookTools } from "./playbook.js"

export function createToolServer(projectDir: string, reporter?: ProgressReporter) {
	const buildTool = createBuildTool(projectDir, reporter)
	const { readPlaybookTool, listPlaybooksTool } = createPlaybookTools(projectDir)

	return createSdkMcpServer({
		name: "electric-agent-tools",
		version: "1.0.0",
		tools: [buildTool, readPlaybookTool, listPlaybooksTool],
	})
}
