import { useMemo } from "react"
import type { ConsoleEntry } from "../lib/event-types"

export interface FileState {
	path: string
	content: string | null
	operation: "write" | "edit"
	partial: boolean
}

export function useFileTracker(entries: ConsoleEntry[]): Map<string, FileState> {
	return useMemo(() => {
		const files = new Map<string, FileState>()

		for (const entry of entries) {
			if (entry.kind !== "tool_use") continue

			const filePath = entry.tool_input.file_path as string | undefined
			if (!filePath) continue

			if (entry.tool_name === "Write") {
				const content = (entry.tool_input.content as string) ?? null
				files.set(filePath, {
					path: filePath,
					content,
					operation: "write",
					partial: false,
				})
			} else if (entry.tool_name === "Edit") {
				const existing = files.get(filePath)
				if (existing?.content && !existing.partial) {
					// Try to apply the edit in-place
					const oldStr = entry.tool_input.old_string as string | undefined
					const newStr = entry.tool_input.new_string as string | undefined
					if (oldStr && newStr !== undefined && existing.content.includes(oldStr)) {
						files.set(filePath, {
							...existing,
							content: existing.content.replace(oldStr, newStr),
							operation: "edit",
						})
						continue
					}
				}
				// Can't apply — mark as partial
				files.set(filePath, {
					path: filePath,
					content: existing?.content ?? null,
					operation: "edit",
					partial: true,
				})
			}
		}

		return files
	}, [entries])
}
