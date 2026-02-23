import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { Outlet, useLocation, useNavigate } from "react-router-dom"
import { Sidebar } from "../components/Sidebar"
import { Toaster } from "../components/Toaster"
import { deleteSession, fetchKeychainCredentials, listSessions, type SessionInfo } from "../lib/api"
import {
	hasApiKey as checkHasApiKey,
	hasGhToken as checkHasGhToken,
	getOauthToken,
	setOauthToken,
} from "../lib/credentials"

export type AuthSource = "api-key" | "keychain" | null

export interface PendingProject {
	name: string
}

interface AppContextValue {
	sessions: SessionInfo[]
	pendingProject: PendingProject | null
	authSource: AuthSource
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
	const [authSource, setAuthSource] = useState<AuthSource>(null)
	const [hasGhToken, setHasGhToken] = useState<boolean | null>(null)
	const [showSettings, setShowSettings] = useState(false)
	const [loading] = useState(false)
	const [pendingProject, setPendingProject] = useState<PendingProject | null>(null)
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
			// Clear pending project once real sessions have loaded
			setPendingProject(null)
		} catch {
			// ignore
		}
	}, [])

	const refreshSettings = useCallback(async () => {
		const ghToken = checkHasGhToken()
		setHasGhToken(ghToken)

		// Check local credentials first
		if (checkHasApiKey()) {
			setAuthSource("api-key")
			return
		}
		if (getOauthToken()) {
			setAuthSource("keychain")
			return
		}

		// Try loading OAuth token from macOS Keychain via server
		try {
			const { oauthToken } = await fetchKeychainCredentials()
			if (oauthToken) {
				setOauthToken(oauthToken)
				setAuthSource("keychain")
				return
			}
		} catch {
			// Server not reachable or not on macOS — ignore
		}
		setAuthSource(null)
		setShowSettings(true)
	}, [])

	useEffect(() => {
		refreshSessions()
		refreshSettings()
	}, [refreshSessions, refreshSettings])

	const handleNewProject = useCallback(
		(description: string) => {
			// Show a faded placeholder avatar while the session is being created
			const words = description.split(/\s+/).slice(0, 3).join(" ")
			setPendingProject({ name: words || "New project" })
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
		pendingProject,
		authSource,
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
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						width="16"
						height="16"
						aria-label="Settings"
					>
						<title>Settings</title>
						<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
						<circle cx="12" cy="12" r="3" />
					</svg>
				</button>
			</div>
			<Toaster />
		</AppContext.Provider>
	)
}
