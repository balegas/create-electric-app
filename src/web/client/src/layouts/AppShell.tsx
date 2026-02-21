import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { Outlet, useLocation, useNavigate } from "react-router-dom"
import { Sidebar } from "../components/Sidebar"
import { Toaster } from "../components/Toaster"
import { deleteSession, getSettings, listSessions, type SessionInfo } from "../lib/api"

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
		getSettings()
			.then((data) => {
				setHasApiKey(data.hasApiKey)
				setHasGhToken(data.hasGhToken)
				if (!data.hasApiKey) setShowSettings(true)
			})
			.catch(() => {})
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
			</div>
			<Toaster />
		</AppContext.Provider>
	)
}
