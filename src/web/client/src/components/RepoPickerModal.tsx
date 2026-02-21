import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { type GhBranch, type GhRepo, listBranches, listGithubRepos } from "../lib/api"

interface RepoPickerModalProps {
	onSelect: (repoUrl: string, branch: string) => void
	onClose: () => void
}

function formatDate(dateStr: string): string {
	const diff = Date.now() - new Date(dateStr).getTime()
	const minutes = Math.floor(diff / 60000)
	if (minutes < 1) return "just now"
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.floor(hours / 24)
	return `${days}d ago`
}

export function RepoPickerModal({ onSelect, onClose }: RepoPickerModalProps) {
	const [repos, setRepos] = useState<GhRepo[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [filter, setFilter] = useState("")

	// Branch selection step
	const [selectedRepo, setSelectedRepo] = useState<GhRepo | null>(null)
	const [branches, setBranches] = useState<GhBranch[]>([])
	const [loadingBranches, setLoadingBranches] = useState(false)
	const [branchFilter, setBranchFilter] = useState("")
	const [newBranchName, setNewBranchName] = useState("")
	const [showNewBranch, setShowNewBranch] = useState(false)

	useEffect(() => {
		listGithubRepos()
			.then((data) => {
				setRepos(data.repos)
				setLoading(false)
			})
			.catch((err) => {
				setError(err instanceof Error ? err.message : "Failed to load repos")
				setLoading(false)
			})
	}, [])

	function handleSelectRepo(repo: GhRepo) {
		setSelectedRepo(repo)
		setLoadingBranches(true)
		setBranches([])
		setBranchFilter("")
		setShowNewBranch(false)
		setNewBranchName("")

		listBranches(repo.nameWithOwner)
			.then((data) => {
				setBranches(data.branches)
				setLoadingBranches(false)
			})
			.catch(() => {
				setLoadingBranches(false)
			})
	}

	function handleBack() {
		setSelectedRepo(null)
		setBranches([])
		setBranchFilter("")
		setShowNewBranch(false)
	}

	function handleSelectBranch(branchName: string) {
		if (selectedRepo) {
			onSelect(selectedRepo.url, branchName)
		}
	}

	const filtered = filter
		? repos.filter((r) => r.nameWithOwner.toLowerCase().includes(filter.toLowerCase()))
		: repos

	const filteredBranches = branchFilter
		? branches.filter((b) => b.name.toLowerCase().includes(branchFilter.toLowerCase()))
		: branches

	// Sort: default branch first, then alphabetically
	const sortedBranches = [...filteredBranches].sort((a, b) => {
		if (a.isDefault && !b.isDefault) return -1
		if (!a.isDefault && b.isDefault) return 1
		return a.name.localeCompare(b.name)
	})

	return createPortal(
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 500 }}>
				{!selectedRepo ? (
					<>
						<div className="modal-title">Resume from GitHub</div>
						<div style={{ marginTop: 12 }}>
							<input
								type="text"
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
								placeholder="Filter repositories..."
								style={{ width: "100%", boxSizing: "border-box" }}
							/>
						</div>

						{loading && (
							<div style={{ padding: "24px 0", textAlign: "center", color: "var(--text-subtle)" }}>
								Loading repositories...
							</div>
						)}

						{error && (
							<div style={{ padding: "16px 0", color: "var(--red)", fontSize: 13 }}>{error}</div>
						)}

						{!loading && !error && (
							<div className="repo-picker-list">
								{filtered.length === 0 ? (
									<div
										style={{
											padding: 16,
											textAlign: "center",
											color: "var(--text-subtle)",
											fontSize: 13,
										}}
									>
										{filter ? "No matching repos" : "No repos found"}
									</div>
								) : (
									filtered.map((repo) => (
										<div
											key={repo.nameWithOwner}
											className="repo-picker-item"
											onClick={() => handleSelectRepo(repo)}
										>
											<span className="repo-picker-item-name">{repo.nameWithOwner}</span>
											<span className="repo-picker-item-date">{formatDate(repo.updatedAt)}</span>
										</div>
									))
								)}
							</div>
						)}

						<div className="modal-actions" style={{ marginTop: 16 }}>
							<button type="button" className="modal-btn" onClick={onClose}>
								Cancel
							</button>
						</div>
					</>
				) : (
					<>
						<div className="modal-title">
							<button
								type="button"
								onClick={handleBack}
								style={{
									background: "none",
									border: "none",
									color: "var(--text-muted)",
									cursor: "pointer",
									padding: "0 8px 0 0",
									fontSize: 14,
								}}
							>
								&larr;
							</button>
							{selectedRepo.nameWithOwner}
						</div>
						<div style={{ marginTop: 12 }}>
							<input
								type="text"
								value={branchFilter}
								onChange={(e) => setBranchFilter(e.target.value)}
								placeholder="Filter branches..."
								style={{ width: "100%", boxSizing: "border-box" }}
							/>
						</div>

						{loadingBranches && (
							<div style={{ padding: "24px 0", textAlign: "center", color: "var(--text-subtle)" }}>
								Loading branches...
							</div>
						)}

						{!loadingBranches && (
							<div className="repo-picker-list">
								{sortedBranches.map((branch) => (
									<div
										key={branch.name}
										className="repo-picker-item"
										onClick={() => handleSelectBranch(branch.name)}
									>
										<span className="repo-picker-item-name">
											{branch.name}
											{branch.isDefault && (
												<span
													style={{
														marginLeft: 8,
														fontSize: 11,
														color: "var(--text-subtle)",
														fontWeight: 400,
													}}
												>
													default
												</span>
											)}
										</span>
									</div>
								))}

								{/* Create new branch option */}
								{!showNewBranch ? (
									<div
										className="repo-picker-item"
										style={{ color: "var(--brand-1)" }}
										onClick={() => setShowNewBranch(true)}
									>
										<span className="repo-picker-item-name">+ Create new branch</span>
									</div>
								) : (
									<div style={{ padding: "8px 12px", display: "flex", gap: 8 }}>
										<input
											type="text"
											value={newBranchName}
											onChange={(e) => setNewBranchName(e.target.value)}
											onKeyDown={(e) => {
												if (e.key === "Enter" && newBranchName.trim()) {
													handleSelectBranch(newBranchName.trim())
												}
											}}
											placeholder="branch-name"
											style={{ flex: 1 }}
										/>
										<button
											type="button"
											className="modal-btn modal-btn-primary"
											disabled={!newBranchName.trim()}
											onClick={() => handleSelectBranch(newBranchName.trim())}
										>
											Create
										</button>
									</div>
								)}
							</div>
						)}

						<div className="modal-actions" style={{ marginTop: 16 }}>
							<button type="button" className="modal-btn" onClick={handleBack}>
								Back
							</button>
							<button type="button" className="modal-btn" onClick={onClose}>
								Cancel
							</button>
						</div>
					</>
				)}
			</div>
		</div>,
		document.body,
	)
}
