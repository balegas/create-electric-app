import { useCallback, useEffect, useMemo, useState } from "react"

interface FileTreeProps {
	files: Set<string>
	prefix: string
	selectedPath: string | null
	onSelect: (path: string) => void
}

interface TreeNode {
	name: string
	fullPath: string
	isDir: boolean
	children: TreeNode[]
}

function findCommonPrefix(paths: string[]): string {
	if (paths.length === 0) return ""
	const parts = paths.map((p) => p.split("/").filter(Boolean))
	const first = parts[0]
	let prefixLen = 0

	for (let i = 0; i < first.length; i++) {
		if (parts.every((p) => p[i] === first[i])) {
			prefixLen = i + 1
		} else {
			break
		}
	}

	if (prefixLen === 0) return ""
	const prefix = first.slice(0, prefixLen).join("/")
	return `${prefix}/`
}

function buildTree(paths: string[]): { tree: TreeNode[]; prefix: string } {
	if (paths.length === 0) return { tree: [], prefix: "" }

	const prefix = findCommonPrefix(paths)
	const stripped = prefix ? paths.map((p) => p.slice(prefix.length)) : paths

	const root: TreeNode = { name: "", fullPath: "", isDir: true, children: [] }

	for (let idx = 0; idx < stripped.length; idx++) {
		const relativePath = stripped[idx]
		const originalPath = paths[idx]
		const parts = relativePath.split("/").filter(Boolean)
		let current = root

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i]
			const isLast = i === parts.length - 1

			let child = current.children.find((c) => c.name === part)
			if (!child) {
				child = {
					name: part,
					fullPath: isLast ? originalPath : "",
					isDir: !isLast,
					children: [],
				}
				current.children.push(child)
			}
			current = child
		}
	}

	// Collapse single-child directories
	function collapse(nodes: TreeNode[]): TreeNode[] {
		return nodes.map((node) => {
			while (node.isDir && node.children.length === 1 && node.children[0].isDir) {
				const child = node.children[0]
				node = {
					name: `${node.name}/${child.name}`,
					fullPath: child.fullPath,
					isDir: true,
					children: child.children,
				}
			}
			if (node.children.length > 0) {
				node = { ...node, children: collapse(node.children) }
			}
			return node
		})
	}

	// Sort: directories first, then alphabetically
	function sortNodes(nodes: TreeNode[]) {
		nodes.sort((a, b) => {
			if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
			return a.name.localeCompare(b.name)
		})
		for (const node of nodes) {
			if (node.children.length > 0) sortNodes(node.children)
		}
	}

	const collapsed = collapse(root.children)
	sortNodes(collapsed)
	return { tree: collapsed, prefix }
}

function TreeItem({
	node,
	depth,
	selectedPath,
	onSelect,
	expandedDirs,
	toggleDir,
}: {
	node: TreeNode
	depth: number
	selectedPath: string | null
	onSelect: (path: string) => void
	expandedDirs: Set<string>
	toggleDir: (key: string) => void
}) {
	const dirKey = `${depth}:${node.name}`
	const isExpanded = expandedDirs.has(dirKey)

	if (node.isDir) {
		return (
			<>
				<div
					className="file-tree-item file-tree-dir"
					style={{ paddingLeft: `${8 + depth * 12}px` }}
					onClick={() => toggleDir(dirKey)}
				>
					<span className={`file-tree-item-icon ${isExpanded ? "expanded" : ""}`}>{"\u25B8"}</span>
					<span className="file-tree-item-name">{node.name}</span>
				</div>
				{isExpanded &&
					node.children.map((child) => (
						<TreeItem
							key={child.fullPath || child.name}
							node={child}
							depth={depth + 1}
							selectedPath={selectedPath}
							onSelect={onSelect}
							expandedDirs={expandedDirs}
							toggleDir={toggleDir}
						/>
					))}
			</>
		)
	}

	return (
		<div
			className={`file-tree-item ${selectedPath === node.fullPath ? "selected" : ""}`}
			style={{ paddingLeft: `${8 + depth * 12}px` }}
			onClick={() => onSelect(node.fullPath)}
		>
			<span className="file-tree-item-icon">{"\u2022"}</span>
			<span className="file-tree-item-name">{node.name}</span>
		</div>
	)
}

export function FileTree({ files, prefix: serverPrefix, selectedPath, onSelect }: FileTreeProps) {
	const paths = useMemo(() => [...files].sort(), [files])
	const { tree, prefix } = useMemo(() => buildTree(paths), [paths])
	const displayPrefix = serverPrefix || prefix

	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set<string>())

	// Auto-expand top-level dirs when tree changes
	useEffect(() => {
		const topLevel = new Set<string>()
		for (const node of tree) {
			if (node.isDir) {
				topLevel.add(`0:${node.name}`)
			}
		}
		setExpandedDirs((prev) => {
			const next = new Set(prev)
			for (const key of topLevel) next.add(key)
			return next
		})
	}, [tree])

	const toggleDir = useCallback((key: string) => {
		setExpandedDirs((prev) => {
			const next = new Set(prev)
			if (next.has(key)) {
				next.delete(key)
			} else {
				next.add(key)
			}
			return next
		})
	}, [])

	if (tree.length === 0) {
		return <div className="right-panel-empty">No files yet</div>
	}

	return (
		<div className="file-tree">
			{displayPrefix && <div className="file-tree-prefix">{displayPrefix.replace(/\/$/, "")}</div>}
			{tree.map((node) => (
				<TreeItem
					key={node.fullPath || node.name}
					node={node}
					depth={0}
					selectedPath={selectedPath}
					onSelect={onSelect}
					expandedDirs={expandedDirs}
					toggleDir={toggleDir}
				/>
			))}
		</div>
	)
}
