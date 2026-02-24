import { highlight } from "sugar-high"
import type { ConsoleEntry } from "../lib/event-types"
import { Duration } from "./ConsoleEntry"

type ToolEntry = Extract<ConsoleEntry, { kind: "tool_use" }>

function getToolSummary(entry: ToolEntry): string {
	const { tool_name, tool_input } = entry
	if (tool_name === "Glob") {
		const pattern = (tool_input.pattern as string) || "*"
		const dir = tool_input.path as string | undefined
		return dir ? `${pattern} in ${dir}` : pattern
	}
	if (tool_name === "Grep") {
		const pattern = (tool_input.pattern as string) || ""
		const parts: string[] = [pattern]
		if (tool_input.path) parts.push(`in ${tool_input.path}`)
		if (tool_input.glob) parts.push(`(${tool_input.glob})`)
		return parts.join(" ")
	}
	if (tool_name === "Read") {
		const filePath = (tool_input.file_path as string) || "unknown file"
		const parts: string[] = [filePath]
		if (tool_input.offset) parts.push(`offset:${tool_input.offset}`)
		if (tool_input.limit) parts.push(`limit:${tool_input.limit}`)
		return parts.join(" ")
	}
	if (tool_name === "Write" || tool_name === "Edit") {
		return (tool_input.file_path as string) || "unknown file"
	}
	if (tool_name === "Bash") {
		return ((tool_input.command as string) || "").slice(0, 80)
	}
	if (tool_name.includes("playbook")) {
		return (tool_input.name as string) || "read"
	}
	if (tool_name.includes("build")) {
		return "pnpm build + check"
	}
	return tool_name
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

function HighlightedPre({ text, maxLen }: { text: string; maxLen: number }) {
	const truncated = text.length > maxLen
	const content = truncated ? text.slice(0, maxLen) : text
	const html = highlight(content) + (truncated ? "\n... (truncated)" : "")
	// biome-ignore lint/security/noDangerouslySetInnerHtml: sugar-high produces safe span-only HTML
	return <pre dangerouslySetInnerHTML={{ __html: html }} />
}

export function ToolExecution({ entry, duration }: { entry: ToolEntry; duration: string | null }) {
	const isLoading = entry.tool_response === null
	const isBash = entry.tool_name === "Bash" || entry.tool_name === "bash"
	const command = isBash ? (entry.tool_input.command as string) || "" : ""
	if (isBash) {
		return (
			<details className="tool-inline">
				<summary>
					{entry.agent && <span className="tool-inline-agent">[{entry.agent}]</span>}
					<span className="tool-inline-name">$</span>
					<span className="tool-inline-command">{command}</span>
					{isLoading ? <span className="spinner-inline" /> : <Duration value={duration} />}
				</summary>
				<div className="tool-inline-body">
					{entry.tool_response !== null && (
						<HighlightedPre text={entry.tool_response} maxLen={5000} />
					)}
				</div>
			</details>
		)
	}

	return (
		<details className="tool-inline">
			<summary>
				{entry.agent && <span className="tool-inline-agent">[{entry.agent}]</span>}
				<span className="tool-inline-name">{entry.tool_name}</span>
				<span className="tool-inline-summary">{getToolSummary(entry)}</span>
				{isLoading ? <span className="spinner-inline" /> : <Duration value={duration} />}
			</summary>
			<div className="tool-inline-body">
				<div className="section-label">Input</div>
				<HighlightedPre text={formatInput(entry.tool_input)} maxLen={5000} />
				{entry.tool_response !== null && (
					<>
						<div className="section-label">Output</div>
						<HighlightedPre text={entry.tool_response} maxLen={5000} />
					</>
				)}
			</div>
		</details>
	)
}
