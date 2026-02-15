import type { ConsoleEntry } from "../lib/event-types"

type ToolEntry = Extract<ConsoleEntry, { kind: "tool" }>

function getToolSummary(entry: ToolEntry): string {
	const { toolName, input } = entry
	if (toolName === "Write" || toolName === "Edit") {
		return (input.file_path as string) || "unknown file"
	}
	if (toolName === "Bash") {
		return ((input.command as string) || "").slice(0, 80)
	}
	if (toolName.includes("playbook")) {
		return (input.name as string) || "read"
	}
	if (toolName.includes("build")) {
		return "pnpm build + check"
	}
	return toolName
}

function formatInput(input: Record<string, unknown>): string {
	const entries = Object.entries(input)
	return entries
		.map(([key, value]) => {
			const str = typeof value === "string" ? value : JSON.stringify(value, null, 2)
			if (str.length > 500) {
				return `${key}: ${str.slice(0, 500)}... (${str.length} chars)`
			}
			return `${key}: ${str}`
		})
		.join("\n")
}

export function ToolExecution({ entry }: { entry: ToolEntry }) {
	const isLoading = entry.output === null

	return (
		<details className="tool-exec">
			<summary>
				<span className="arrow">&#9654;</span>
				<span className="tool-name">{entry.toolName}</span>
				<span className="tool-summary">{getToolSummary(entry)}</span>
				{isLoading && <span className="spinner" />}
			</summary>
			<div className="tool-body">
				<div className="section-label">Input</div>
				<pre>{formatInput(entry.input)}</pre>
				{entry.output !== null && (
					<>
						<div className="section-label">Output</div>
						<pre>
							{entry.output.slice(0, 5000)}
							{entry.output.length > 5000 ? "\n... (truncated)" : ""}
						</pre>
					</>
				)}
			</div>
		</details>
	)
}
