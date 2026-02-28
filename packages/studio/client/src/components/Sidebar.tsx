import { useCallback, useEffect, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { useAppContext } from "../layouts/AppShell"
import { createSharedSession } from "../lib/api"
import { removeJoinedSharedSession } from "../lib/shared-session-store"
import { getAvatarColor, SessionListItem } from "./SessionListItem"

interface SidebarProps {
	collapsed: boolean
	onToggle: () => void
	mobileOpen?: boolean
	onMobileClose?: () => void
}

function CollapseIcon({ collapsed }: { collapsed: boolean }) {
	return (
		<svg
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-label={collapsed ? "Expand menu" : "Collapse menu"}
		>
			<title>{collapsed ? "Expand menu" : "Collapse menu"}</title>
			{/* Sidebar panel icon — left panel with arrow */}
			<rect x="2" y="2" width="12" height="12" rx="2" />
			<line x1="6" y1="2" x2="6" y2="14" />
			{collapsed ? (
				<polyline points="9 6.5 11.5 8 9 9.5" />
			) : (
				<polyline points="11.5 6.5 9 8 11.5 9.5" />
			)}
		</svg>
	)
}

function LinkIcon() {
	return (
		<svg
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			width="14"
			height="14"
		>
			<title>Join room</title>
			<path d="M6.5 9.5a3.5 3.5 0 0 0 5 0l2-2a3.5 3.5 0 0 0-5-5l-1 1" />
			<path d="M9.5 6.5a3.5 3.5 0 0 0-5 0l-2 2a3.5 3.5 0 0 0 5 5l1-1" />
		</svg>
	)
}

export function Sidebar({ collapsed, onToggle, mobileOpen, onMobileClose }: SidebarProps) {
	const {
		sessions,
		pendingProject,
		handleDeleteSession,
		joinedSharedSessions,
		refreshJoinedSharedSessions,
	} = useAppContext()
	const navigate = useNavigate()
	const location = useLocation()

	const [joinInputOpen, setJoinInputOpen] = useState(false)
	const [joinCode, setJoinCode] = useState("")
	const [createInputOpen, setCreateInputOpen] = useState(false)
	const [createName, setCreateName] = useState("")

	// Close inline inputs when sidebar collapses
	useEffect(() => {
		if (collapsed) {
			setJoinInputOpen(false)
			setJoinCode("")
			setCreateInputOpen(false)
			setCreateName("")
		}
	}, [collapsed])

	const activeSessionId = location.pathname.startsWith("/session/")
		? location.pathname.split("/session/")[1]
		: null

	const activeSharedCode = location.pathname.startsWith("/shared/")
		? location.pathname.split("/shared/")[1]
		: null

	const sortedSessions = [...sessions].sort(
		(a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime(),
	)

	const handleNavigate = (path: string) => {
		navigate(path)
		onMobileClose?.()
	}

	const handleJoin = useCallback(() => {
		const trimmed = joinCode.trim()
		if (!trimmed) return
		navigate(`/shared/${trimmed}`)
		setJoinCode("")
		setJoinInputOpen(false)
		onMobileClose?.()
	}, [joinCode, navigate, onMobileClose])

	const handleRemoveShared = useCallback(
		(code: string) => {
			removeJoinedSharedSession(code)
			refreshJoinedSharedSessions()
		},
		[refreshJoinedSharedSessions],
	)

	const handleCreateShared = useCallback(async () => {
		const trimmed = createName.trim()
		if (!trimmed) return
		try {
			const { code } = await createSharedSession(trimmed)
			setCreateName("")
			setCreateInputOpen(false)
			navigate(`/shared/${code}`)
			onMobileClose?.()
		} catch (err) {
			console.error("Failed to create shared session:", err)
		}
	}, [createName, navigate, onMobileClose])

	return (
		<aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
			<div className="sidebar-header">
				<svg className="sidebar-icon" viewBox="0 0 192 192" aria-label="Electric">
					<title>Electric</title>
					<path
						d="M106.992 16.1244C107.711 15.4029 108.683 15 109.692 15H170L84.0082 101.089C83.2888 101.811 82.3171 102.213 81.3081 102.213H21L106.992 16.1244Z"
						fill="var(--brand-1)"
					/>
					<path
						d="M96.4157 104.125C96.4157 103.066 97.2752 102.204 98.331 102.204H170L96.4157 176V104.125Z"
						fill="var(--brand-1)"
					/>
				</svg>
				<span className="sidebar-brand">Electric Agent</span>
			</div>

			<div className="sidebar-sessions">
				<div className="sidebar-section-label">Sessions</div>

				<div className="session-item" onClick={() => handleNavigate("/")} title="New App">
					<span className="session-avatar new-project-avatar">+</span>
					<div className="session-item-details">
						<div className="session-item-name">New App</div>
					</div>
				</div>
				{pendingProject && (
					<div className="session-item session-item-pending" title={pendingProject.name}>
						<span className="session-avatar session-avatar-pending" />
						<div className="session-item-details">
							<div className="session-item-name">{pendingProject.name}</div>
							<div className="session-item-meta">
								<span>Setting up...</span>
							</div>
						</div>
					</div>
				)}
				{sortedSessions.map((s) => (
					<SessionListItem
						key={s.id}
						session={s}
						active={s.id === activeSessionId}
						onClick={() => handleNavigate(`/session/${s.id}`)}
						onDelete={() => handleDeleteSession(s.id)}
					/>
				))}

				<div className="sidebar-section-label">Rooms</div>

				{createInputOpen && !collapsed ? (
					<div className="sidebar-join-input">
						<input
							type="text"
							placeholder="Room name..."
							value={createName}
							onChange={(e) => setCreateName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") handleCreateShared()
								if (e.key === "Escape") {
									setCreateInputOpen(false)
									setCreateName("")
								}
							}}
						/>
						<button
							type="button"
							className="sidebar-join-go"
							onClick={handleCreateShared}
							disabled={!createName.trim()}
						>
							Go
						</button>
					</div>
				) : (
					<div
						className="session-item"
						onClick={() => {
							if (collapsed) {
								onToggle()
							}
							setCreateInputOpen(true)
						}}
						title="Create room"
					>
						<span className="session-avatar new-project-avatar">+</span>
						<div className="session-item-details">
							<div className="session-item-name">Create</div>
						</div>
					</div>
				)}

				{joinInputOpen && !collapsed ? (
					<div className="sidebar-join-input">
						<input
							type="text"
							placeholder="Invite code..."
							value={joinCode}
							onChange={(e) => setJoinCode(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") handleJoin()
								if (e.key === "Escape") {
									setJoinInputOpen(false)
									setJoinCode("")
								}
							}}
						/>
						<button
							type="button"
							className="sidebar-join-go"
							onClick={handleJoin}
							disabled={!joinCode.trim()}
						>
							Go
						</button>
					</div>
				) : (
					<div
						className="session-item"
						onClick={() => {
							if (collapsed) {
								onToggle()
							}
							setJoinInputOpen(true)
						}}
						title="Join room"
					>
						<span className="session-avatar new-project-avatar">
							<LinkIcon />
						</span>
						<div className="session-item-details">
							<div className="session-item-name">Join</div>
						</div>
					</div>
				)}

				{joinedSharedSessions.map((s) => {
					const color = getAvatarColor(s.id)
					const initials = s.name
						.split(/[-_ ]+/)
						.slice(0, 2)
						.map((w) => w.charAt(0).toUpperCase())
						.join("")
					return (
						<div
							key={s.code}
							className={`session-item ${activeSharedCode === s.code ? "active" : ""}`}
							onClick={() => handleNavigate(`/shared/${s.code}`)}
							title={s.name}
						>
							<span
								className="session-avatar session-avatar-shared"
								style={{ background: color.bg, color: color.fg }}
							>
								{initials}
							</span>
							<div className="session-item-details">
								<div className="session-item-name">{s.name}</div>
								<div className="session-item-meta">
									<span>{s.code}</span>
								</div>
							</div>
							<button
								type="button"
								className="session-item-delete"
								onClick={(e) => {
									e.stopPropagation()
									handleRemoveShared(s.code)
								}}
								title="Remove"
							>
								&times;
							</button>
						</div>
					)
				})}
			</div>

			<div className="sidebar-collapse">
				<button type="button" className="sidebar-collapse-btn" onClick={onToggle}>
					<CollapseIcon collapsed={collapsed} />
					<span className="sidebar-collapse-label">
						{collapsed ? "Expand menu" : "Collapse menu"}
					</span>
				</button>
			</div>
		</aside>
	)
}
