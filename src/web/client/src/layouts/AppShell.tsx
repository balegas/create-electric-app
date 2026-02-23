import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { Outlet, useLocation, useNavigate } from "react-router-dom"
import { Sidebar } from "../components/Sidebar"
import { Toaster } from "../components/Toaster"
import { deleteSession, listSessions, type SessionInfo } from "../lib/api"
import { hasApiKey as checkHasApiKey, hasGhToken as checkHasGhToken } from "../lib/credentials"

interface AppContextValue {
	sessions: SessionInfo[]
	hasApiKey: boolean | null
	hasGhToken: boolean | null
	showSettings: boolean
	setShowSettings: (v: boolean | ((prev: boolean) => boolean)) => void
	refreshSessions: () => Promise<void>
	refreshSettings: () => void
	handleNewProject: (description: string) => Promise<void>
	handleDeleteSession: (sessionId: string) => Promise<void>
	loading: boolean
}

const AppContext = createContext<AppContextValue | null>(null)

export function useAppContext() {
	const ctx = useContext(AppContext)
	if (!ctx) throw new Error("useAppContext must be used within AppShell")
	return ctx
}

export function AppShell() {
	const [sessions, setSessions] = useState<SessionInfo[]>([])
	const [hasApiKey, setHasApiKey] = useState<boolean | null>(null)
	const [hasGhToken, setHasGhToken] = useState<boolean | null>(null)
	const [showSettings, setShowSettings] = useState(false)
	const [loading] = useState(false)
	const [sidebarCollapsed, setSidebarCollapsed] = useState(
		() => localStorage.getItem("sidebarCollapsed") === "true",
	)
	const toggleSidebar = useCallback(() => {
		setSidebarCollapsed((v) => {
			localStorage.setItem("sidebarCollapsed", String(!v))
			return !v
		})
	}, [])

	const navigate = useNavigate()
	const location = useLocation()

	// Auto-collapse sidebar when first navigating to a session page
	const prevPathRef = useRef(location.pathname)
	useEffect(() => {
		const wasSession = prevPathRef.current.startsWith("/session/")
		const isSession = location.pathname.startsWith("/session/")
		prevPathRef.current = location.pathname

		// Only auto-collapse when entering a session from a non-session page
		if (isSession && !wasSession) {
			setSidebarCollapsed(true)
			localStorage.setItem("sidebarCollapsed", "true")
		}
		// Auto-expand when going back to home
		if (!isSession && wasSession) {
			setSidebarCollapsed(false)
			localStorage.setItem("sidebarCollapsed", "false")
		}
	}, [location.pathname])

	const refreshSessions = useCallback(async () => {
		try {
			const data = await listSessions()
			setSessions(data.sessions)
		} catch {
			// ignore
		}
	}, [])

	const refreshSettings = useCallback(() => {
		const apiKey = checkHasApiKey()
		const ghToken = checkHasGhToken()
		setHasApiKey(apiKey)
		setHasGhToken(ghToken)
		if (!apiKey) setShowSettings(true)
	}, [])

	useEffect(() => {
		refreshSessions()
		refreshSettings()
	}, [refreshSessions, refreshSettings])

	const handleNewProject = useCallback(
		(description: string) => {
			// Navigate immediately — SessionPage will create the session
			navigate("/session/new", { state: { description } })
		},
		[navigate],
	)

	const handleDeleteSession = useCallback(
		async (sessionId: string) => {
			try {
				await deleteSession(sessionId)
				await refreshSessions()
				// Navigate home if the deleted session was active
				if (location.pathname === `/session/${sessionId}`) {
					navigate("/")
				}
			} catch (err) {
				console.error("Failed to delete session:", err)
			}
		},
		[refreshSessions, location.pathname, navigate],
	)

	const ctx: AppContextValue = {
		sessions,
		hasApiKey,
		hasGhToken,
		showSettings,
		setShowSettings,
		refreshSessions,
		refreshSettings,
		handleNewProject,
		handleDeleteSession,
		loading,
	}

	return (
		<AppContext.Provider value={ctx}>
			<div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
				<Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
				<main className="main-content">
					<Outlet />
				</main>
				<button
					type="button"
					className="global-settings-btn"
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
			<Toaster />
		</AppContext.Provider>
	)
}
