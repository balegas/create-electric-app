import { useLocation, useNavigate } from "react-router-dom"
import { useAppContext } from "../layouts/AppShell"
import { SessionListItem } from "./SessionListItem"

interface SidebarProps {
	collapsed: boolean
	onToggle: () => void
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
				<button
					type="button"
					className="sidebar-settings-btn"
					onClick={() => setShowSettings((v) => !v)}
					title="Settings"
				>
					<svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16" aria-label="Settings">
						<title>Settings</title>
						<path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492ZM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0Z" />
						<path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319Zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.422 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.422 1.6-1.185 1.184l-.292-.159a1.873 1.873 0 0 0-2.692 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.693-1.115l-.291.16c-.764.415-1.6-.422-1.184-1.185l.159-.292A1.873 1.873 0 0 0 2.98 9.796l-.318-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 4.096 5.24l-.16-.291c-.415-.764.422-1.6 1.185-1.184l.292.159A1.873 1.873 0 0 0 8.1 2.897l.094-.318Z" />
					</svg>
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
