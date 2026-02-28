import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { Outlet, useLocation, useNavigate } from "react-router-dom"
import { Sidebar } from "../components/Sidebar"
import { Toaster } from "../components/Toaster"
import { deleteSession, fetchKeychainCredentials, type SessionInfo } from "../lib/api"
import {
	hasApiKey as checkHasApiKey,
	hasGhToken as checkHasGhToken,
	getOauthToken,
	isManualOauth,
	setOauthToken,
} from "../lib/credentials"
import { getSessions, removeSession as removeSessionFromStore } from "../lib/session-store"
import { getJoinedSharedSessions, type JoinedSharedSession } from "../lib/shared-session-store"

export type AuthSource = "api-key" | "oauth" | "keychain" | null

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
	refreshSessions: () => void
	refreshSettings: () => void
	handleNewProject: (description: string) => void
	handleDeleteSession: (sessionId: string) => Promise<void>
	loading: boolean
	joinedSharedSessions: JoinedSharedSession[]
	refreshJoinedSharedSessions: () => void
}

const AppContext = createContext<AppContextValue | null>(null)

export function useAppContext() {
	const ctx = useContext(AppContext)
	if (!ctx) throw new Error("useAppContext must be used within AppShell")
	return ctx
}

function useIsMobile() {
	const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768)
	useEffect(() => {
		const mq = window.matchMedia("(max-width: 768px)")
		const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
		mq.addEventListener("change", handler)
		return () => mq.removeEventListener("change", handler)
	}, [])
	return isMobile
}

export function AppShell() {
	// Sessions come from localStorage (private to this browser)
	const [sessions, setSessions] = useState<SessionInfo[]>(() => getSessions())
	const [authSource, setAuthSource] = useState<AuthSource>(null)
	const [hasGhToken, setHasGhToken] = useState<boolean | null>(null)
	const [showSettings, setShowSettings] = useState(false)
	const [loading] = useState(false)
	const [pendingProject, setPendingProject] = useState<PendingProject | null>(null)
	const [joinedSharedSessions, setJoinedSharedSessions] = useState<JoinedSharedSession[]>(() =>
		getJoinedSharedSessions(),
	)
	const [sidebarCollapsed, setSidebarCollapsed] = useState(
		() => localStorage.getItem("sidebarCollapsed") === "true",
	)
	const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
	const isMobile = useIsMobile()

	const toggleSidebar = useCallback(() => {
		setSidebarCollapsed((v) => {
			localStorage.setItem("sidebarCollapsed", String(!v))
			return !v
		})
	}, [])

	const openMobileDrawer = useCallback(() => setMobileDrawerOpen(true), [])
	const closeMobileDrawer = useCallback(() => setMobileDrawerOpen(false), [])

	const navigate = useNavigate()
	const location = useLocation()

	const refreshJoinedSharedSessions = useCallback(() => {
		setJoinedSharedSessions(getJoinedSharedSessions())
	}, [])

	// Reload sessions from localStorage
	const refreshSessions = useCallback(() => {
		setSessions(getSessions())
		setPendingProject(null)
	}, [])

	// Auto-collapse sidebar when first navigating to a session or shared page
	const prevPathRef = useRef(location.pathname)
	useEffect(() => {
		const isDeepPage = (p: string) => p.startsWith("/session/") || p.startsWith("/shared/")
		const wasDeep = isDeepPage(prevPathRef.current)
		const isDeep = isDeepPage(location.pathname)
		prevPathRef.current = location.pathname

		// Close mobile drawer on any navigation
		setMobileDrawerOpen(false)

		// Only auto-collapse when entering a session/shared page from a non-session page
		if (isDeep && !wasDeep) {
			setSidebarCollapsed(true)
			localStorage.setItem("sidebarCollapsed", "true")
		}
		// Auto-expand when going back to home
		if (!isDeep && wasDeep) {
			setSidebarCollapsed(false)
			localStorage.setItem("sidebarCollapsed", "false")
		}

		// Refresh sessions when returning to home (pick up any status updates)
		if (!isDeep) {
			refreshSessions()
		}
	}, [location.pathname, refreshSessions])

	const refreshSettings = useCallback(async () => {
		const ghToken = checkHasGhToken()
		setHasGhToken(ghToken)

		// Check local credentials first
		if (checkHasApiKey()) {
			console.log("[auth] Using API key from localStorage")
			setAuthSource("api-key")
			return
		}

		// Check for manually-set OAuth token (takes priority over keychain)
		if (isManualOauth() && getOauthToken()) {
			const token = getOauthToken()
			console.log(`[auth] Using manual OAuth token: ${token?.slice(0, 10)}...`)
			setAuthSource("oauth")
			return
		}

		// Always refresh OAuth token from macOS Keychain (token may have been
		// rotated via `claude /login` since the last page load)
		try {
			const { oauthToken } = await fetchKeychainCredentials()
			if (oauthToken) {
				console.log(
					`[auth] Using keychain OAuth token: ${oauthToken.slice(0, 10)}... (overwrites any cached token)`,
				)
				setOauthToken(oauthToken)
				setAuthSource("keychain")
				return
			}
			console.log("[auth] Keychain returned no token")
		} catch {
			// Server not reachable or not on macOS — fall back to cached token
			if (getOauthToken()) {
				const token = getOauthToken()
				console.log(`[auth] Keychain unreachable, using cached token: ${token?.slice(0, 10)}...`)
				setAuthSource("keychain")
				return
			}
		}
		console.log("[auth] No credentials found — showing settings")
		setAuthSource(null)
		setShowSettings(true)
	}, [])

	useEffect(() => {
		refreshSettings()
	}, [refreshSettings])

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
				removeSessionFromStore(sessionId)
				refreshSessions()
				if (location.pathname === `/session/${sessionId}`) {
					navigate("/")
				}
			} catch (err) {
				console.error("Failed to delete session:", err)
			}
		},
		[location.pathname, navigate, refreshSessions],
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
		joinedSharedSessions,
		refreshJoinedSharedSessions,
	}

	return (
		<AppContext.Provider value={ctx}>
			<div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
				{isMobile && mobileDrawerOpen && (
					<div
						className="sidebar-backdrop"
						onClick={closeMobileDrawer}
						onKeyDown={(e) => {
							if (e.key === "Escape") closeMobileDrawer()
						}}
					/>
				)}
				<Sidebar
					collapsed={sidebarCollapsed}
					onToggle={toggleSidebar}
					mobileOpen={mobileDrawerOpen}
					onMobileClose={closeMobileDrawer}
				/>
				<main className="main-content">
					<Outlet context={{ openMobileDrawer }} />
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
