import { highlight } from "sugar-high"
import type { ConsoleEntry } from "../lib/event-types"
import { Duration } from "./ConsoleEntry"

type ToolEntry = Extract<ConsoleEntry, { kind: "tool" }>

function getToolSummary(entry: ToolEntry): string {
	const { toolName, input } = entry
	if (toolName === "Glob") {
		const pattern = (input.pattern as string) || "*"
		const dir = input.path as string | undefined
		return dir ? `${pattern} in ${dir}` : pattern
	}
	if (toolName === "Grep") {
		const pattern = (input.pattern as string) || ""
		const parts: string[] = [pattern]
		if (input.path) parts.push(`in ${input.path}`)
		if (input.glob) parts.push(`(${input.glob})`)
		return parts.join(" ")
	}
	if (toolName === "Read") {
		const filePath = (input.file_path as string) || "unknown file"
		const parts: string[] = [filePath]
		if (input.offset) parts.push(`offset:${input.offset}`)
		if (input.limit) parts.push(`limit:${input.limit}`)
		return parts.join(" ")
	}
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

function HighlightedPre({ text, maxLen }: { text: string; maxLen: number }) {
	const truncated = text.length > maxLen
	const content = truncated ? text.slice(0, maxLen) : text
	const html = highlight(content) + (truncated ? "\n... (truncated)" : "")
	// biome-ignore lint/security/noDangerouslySetInnerHtml: sugar-high produces safe span-only HTML
	return <pre dangerouslySetInnerHTML={{ __html: html }} />
}

export function ToolExecution({ entry, duration }: { entry: ToolEntry; duration: string | null }) {
	const isLoading = entry.output === null
	const isBash = entry.toolName === "Bash" || entry.toolName === "bash"
	const command = isBash ? (entry.input.command as string) || "" : ""

	if (isBash) {
		return (
			<details className="tool-inline">
				<summary>
					<span className="tool-inline-name">$</span>
					<span className="tool-inline-command">{command}</span>
					{isLoading ? <span className="spinner-inline" /> : <Duration value={duration} />}
				</summary>
				<div className="tool-inline-body">
					{entry.output !== null && <HighlightedPre text={entry.output} maxLen={5000} />}
				</div>
			</details>
		)
	}

	return (
		<details className="tool-inline">
			<summary>
				<span className="tool-inline-name">{entry.toolName}</span>
				<span className="tool-inline-summary">{getToolSummary(entry)}</span>
				{isLoading ? <span className="spinner-inline" /> : <Duration value={duration} />}
			</summary>
			<div className="tool-inline-body">
				<div className="section-label">Input</div>
				<HighlightedPre text={formatInput(entry.input)} maxLen={5000} />
				{entry.output !== null && (
					<>
						<div className="section-label">Output</div>
						<HighlightedPre text={entry.output} maxLen={5000} />
					</>
				)}
			</div>
		</details>
	)
}
