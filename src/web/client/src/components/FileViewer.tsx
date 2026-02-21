import { highlight } from "sugar-high"

interface FileViewerProps {
	filePath: string | null
	content: string | null
	partial: boolean
	loading: boolean
}

export function FileViewer({ filePath, content, partial, loading }: FileViewerProps) {
	if (!filePath) {
		return <div className="file-viewer-empty">Select a file to view</div>
	}

	const fileName = filePath.split("/").pop() ?? filePath

	return (
		<div className="file-viewer">
			<div className="file-viewer-header">
				<span className="file-viewer-path">{filePath}</span>
				{partial && (
					<span style={{ color: "var(--yellow)", fontSize: 11 }}>content may be partial</span>
				)}
			</div>
			<div className="file-viewer-content">
				{loading ? (
					<div className="right-panel-empty">Loading...</div>
				) : content ? (
					<HighlightedCode code={content} fileName={fileName} />
				) : (
					<div className="right-panel-empty">No content available</div>
				)}
			</div>
		</div>
	)
}

function LineNumbers({ count }: { count: number }) {
	return (
		<div className="file-viewer-lines" aria-hidden="true">
			{Array.from({ length: count }, (_, i) => (
				<span key={i}>{i + 1}</span>
			))}
		</div>
	)
}

function HighlightedCode({ code, fileName }: { code: string; fileName: string }) {
	const lineCount = code.split("\n").length

	const ext = fileName.split(".").pop()?.toLowerCase()
	const highlightable = [
		"ts",
		"tsx",
		"js",
		"jsx",
		"json",
		"css",
		"html",
		"sql",
		"md",
		"yaml",
		"yml",
	]

	if (ext && highlightable.includes(ext)) {
		const html = highlight(code)
		return (
			<div className="file-viewer-code">
				<LineNumbers count={lineCount} />
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: sugar-high produces safe span-only HTML */}
				<pre dangerouslySetInnerHTML={{ __html: html }} />
			</div>
		)
	}

	return (
		<div className="file-viewer-code">
			<LineNumbers count={lineCount} />
			<pre>{code}</pre>
		</div>
	)
}
