import { useLocation, useNavigate } from "react-router-dom"
import { useAppContext } from "../layouts/AppShell"
import { SessionListItem } from "./SessionListItem"

interface SidebarProps {
	collapsed: boolean
	onToggle: () => void
}

function HamburgerIcon() {
	return (
		<svg
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			aria-label="Toggle sidebar"
		>
			<title>Toggle sidebar</title>
			<line x1="2" y1="4" x2="14" y2="4" />
			<line x1="2" y1="8" x2="14" y2="8" />
			<line x1="2" y1="12" x2="14" y2="12" />
		</svg>
	)
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
	const { sessions, setShowSettings, handleDeleteSession } = useAppContext()
	const navigate = useNavigate()
	const location = useLocation()

	const activeSessionId = location.pathname.startsWith("/session/")
		? location.pathname.split("/session/")[1]
		: null

	const sortedSessions = [...sessions].sort(
		(a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime(),
	)

	return (
		<aside className="sidebar">
			<div className="sidebar-header">
				<svg
					className="sidebar-icon"
					viewBox="0 0 192 192"
					aria-label="Electric"
					onClick={collapsed ? onToggle : undefined}
					style={collapsed ? { cursor: "pointer" } : undefined}
				>
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
				<button type="button" className="sidebar-toggle" onClick={onToggle}>
					<HamburgerIcon />
				</button>
			</div>

			<button type="button" className="sidebar-new-btn" onClick={() => navigate("/")}>
				{collapsed ? "+" : "+ New Project"}
			</button>

			{!collapsed && sortedSessions.length > 0 && (
				<div className="sidebar-section-label">Recent</div>
			)}

			<div className="sidebar-sessions">
				{sortedSessions.map((s) => (
					<SessionListItem
						key={s.id}
						session={s}
						active={s.id === activeSessionId}
						collapsed={collapsed}
						onClick={() => navigate(`/session/${s.id}`)}
						onDelete={() => handleDeleteSession(s.id)}
					/>
				))}
			</div>

			<div className="sidebar-footer">
				<button
					type="button"
					className="sidebar-footer-btn"
					onClick={() => setShowSettings((v) => !v)}
				>
					{collapsed ? "\u2699" : "\u2699 Settings"}
				</button>
			</div>
		</aside>
	)
}
