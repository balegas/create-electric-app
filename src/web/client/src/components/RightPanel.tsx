import { useCallback, useEffect, useMemo, useState } from "react"
import { useFileTracker } from "../hooks/useFileTracker"
import { listFiles, readFileContent } from "../lib/api"
import type { ConsoleEntry } from "../lib/event-types"
import { FileTree } from "./FileTree"
import { FileViewer } from "./FileViewer"

interface RightPanelProps {
	sessionId: string
	entries: ConsoleEntry[]
}

export function RightPanel({ sessionId, entries }: RightPanelProps) {
	const [selectedFile, setSelectedFile] = useState<string | null>(null)
	const [allFiles, setAllFiles] = useState<string[]>([])
	const [filePrefix, setFilePrefix] = useState("")
	const [viewContent, setViewContent] = useState<string | null>(null)
	const [loading, setLoading] = useState(false)
	const trackedFiles = useFileTracker(entries)

	// Count file-write tool events to trigger re-fetches
	const writeCount = useMemo(
		() =>
			entries.filter(
				(e) =>
					e.kind === "tool" &&
					(e.toolName === "Write" ||
						e.toolName === "Edit" ||
						e.toolName === "mcp__electric-agent-tools__build"),
			).length,
		[entries],
	)

	// Fetch full file listing from server whenever a file write occurs
	useEffect(() => {
		let cancelled = false
		async function fetchFiles() {
			try {
				const { files, prefix } = await listFiles(sessionId)
				if (!cancelled) {
					setAllFiles(files)
					setFilePrefix(prefix)
				}
			} catch {
				// ignore — project dir might not exist yet
			}
		}
		fetchFiles()
		return () => {
			cancelled = true
		}
	}, [sessionId, writeCount])

	// Merge: server files + tracked files (edited files take priority)
	const mergedPaths = new Set([...allFiles, ...trackedFiles.keys()])

	// Load file content when selected
	const handleSelect = useCallback(
		async (filePath: string) => {
			setSelectedFile(filePath)
			// If we have tracked content (from Write/Edit), use it
			const tracked = trackedFiles.get(filePath)
			if (tracked?.content) {
				setViewContent(tracked.content)
				return
			}
			// Otherwise fetch from server
			setLoading(true)
			try {
				const { content } = await readFileContent(sessionId, filePath)
				setViewContent(content)
			} catch {
				setViewContent(null)
			} finally {
				setLoading(false)
			}
		},
		[sessionId, trackedFiles],
	)

	const tracked = selectedFile ? trackedFiles.get(selectedFile) : null

	return (
		<div className="code-panel">
			<div className="code-panel-tree">
				<FileTree
					files={mergedPaths}
					prefix={filePrefix}
					selectedPath={selectedFile}
					onSelect={handleSelect}
				/>
			</div>
			<FileViewer
				filePath={selectedFile}
				content={viewContent}
				partial={tracked?.partial ?? false}
				loading={loading}
			/>
		</div>
	)
}
