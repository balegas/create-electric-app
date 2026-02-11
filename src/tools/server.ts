import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import { buildTool } from "./build.js"
import { listPlaybooksTool, readPlaybookTool } from "./playbook.js"

export function createToolServer() {
	return createSdkMcpServer({
		name: "electric-agent-tools",
		version: "1.0.0",
		tools: [buildTool, readPlaybookTool, listPlaybooksTool],
	})
}
