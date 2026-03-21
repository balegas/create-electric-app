import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Box, Text, useApp, useInput } from "ink"
import { ElectricAgentClient } from "@electric-agent/protocol/client"
import type { SessionInfo } from "@electric-agent/protocol/client"
import { TabBar, type Tab } from "./components/TabBar.js"
import { HomeScreen } from "./screens/HomeScreen.js"
import { SessionScreen } from "./screens/SessionScreen.js"
import { RoomScreen } from "./screens/RoomScreen.js"
import { SettingsScreen } from "./screens/SettingsScreen.js"
import SelectInput from "ink-select-input"
import { HelpModal } from "./components/HelpModal.js"
import { useConfig } from "./hooks/useConfig.js"
import { tokenStore } from "./lib/token-store.js"
import {
	loadSessions,
	saveSession,
	deleteStoredSession,
	loadRooms,
	saveRoom,
	type StoredSession,
} from "./lib/session-store.js"

type Screen =
	| { type: "home" }
	| { type: "session"; sessionId: string; projectName?: string }
	| { type: "room"; roomId: string; roomName?: string }
	| { type: "settings" }

export function App({ serverUrl }: { serverUrl?: string }) {
	const { exit } = useApp()
	const { config, updateConfig } = useConfig()
	const [screens, setScreens] = useState<Screen[]>([{ type: "home" }])
	const [activeIndex, setActiveIndex] = useState(0)
	const [sessions, setSessions] = useState<SessionInfo[]>(() => {
		const stored = loadSessions()
		return stored.map(storedToSessionInfo)
	})
	const [storedRooms, setStoredRooms] = useState(() => loadRooms())
	const [connected, setConnected] = useState(false)
	const [devMode, setDevMode] = useState(false)
	const [showGateOverlay, setShowGateOverlay] = useState(false)
	const [showPeek, setShowPeek] = useState(false)
	const [globalError, setGlobalError] = useState<string | null>(null)
	const [loading, setLoading] = useState<string | null>(null)
	const [showHelp, setShowHelp] = useState(false)
	const [browsing, setBrowsing] = useState(false)

	// Use refs for values accessed in the input handler to avoid re-registering
	// the handler on every render (which causes flicker)
	const screensRef = useRef(screens)
	screensRef.current = screens
	const activeIndexRef = useRef(activeIndex)
	activeIndexRef.current = activeIndex
	const showGateOverlayRef = useRef(showGateOverlay)
	showGateOverlayRef.current = showGateOverlay
	const showPeekRef = useRef(showPeek)
	showPeekRef.current = showPeek
	const showHelpRef = useRef(showHelp)
	showHelpRef.current = showHelp

	const baseUrl = serverUrl ?? config.server

	// Restore auth tokens on startup
	useEffect(() => {
		for (const s of loadSessions()) {
			if (s.sessionToken) {
				tokenStore.setSessionToken(s.id, s.sessionToken)
			}
		}
		for (const r of loadRooms()) {
			if (r.roomToken) {
				tokenStore.setRoomToken(r.id, r.roomToken)
			}
			if (r.sessionTokens) {
				for (const [sid, tok] of Object.entries(r.sessionTokens)) {
					tokenStore.setSessionToken(sid, tok)
				}
			}
		}
	}, [])

	// Keychain OAuth token — in-memory only, never persisted to config
	const [keychainToken, setKeychainToken] = useState<string | null>(null)
	const [keychainStatus, setKeychainStatus] = useState<"idle" | "loading" | "found" | "not-found" | "error">("idle")
	const keychainTokenRef = useRef<string | null>(null)
	keychainTokenRef.current = keychainToken

	// Auth priority: API key from config < keychain OAuth (always refreshed)
	// Matches web UI: manual OAuth > keychain > API key
	const client = useMemo(
		() =>
			new ElectricAgentClient({
				baseUrl: `${baseUrl}/api`,
				credentials: () => ({
					apiKey: config.credentials.apiKey,
					oauthToken: keychainTokenRef.current ?? undefined,
					ghToken: config.credentials.githubToken,
				}),
				participant: () => config.participant,
				tokenStore,
			}),
		[baseUrl, config.credentials, config.participant],
	)

	// Check connection + refresh keychain on mount
	useEffect(() => {
		client
			.getConfig()
			.then((cfg) => {
				setConnected(true)
				setDevMode(cfg.devMode)

				// Fetch keychain token (only if no API key is set — API key is user override)
				if (!config.credentials.apiKey) {
					setKeychainStatus("loading")
					client
						.fetchKeychainCredentials()
						.then(({ oauthToken }) => {
							if (oauthToken) {
								setKeychainToken(oauthToken)
								setKeychainStatus("found")
							} else {
								setKeychainStatus("not-found")
							}
						})
						.catch(() => setKeychainStatus("error"))
				}
			})
			.catch(() => {
				setConnected(false)
				setGlobalError(`Cannot connect to server at ${baseUrl}`)
			})
	}, [client, baseUrl, config.credentials.apiKey])

	const activeScreen = screens[activeIndex]

	const addScreen = useCallback(
		(screen: Screen) => {
			setScreens((prev) => {
				const exists = prev.findIndex((s) => {
					if (s.type === "session" && screen.type === "session")
						return s.sessionId === screen.sessionId
					if (s.type === "room" && screen.type === "room") return s.roomId === screen.roomId
					if (s.type === screen.type && s.type === "settings") return true
					return false
				})
				if (exists >= 0) {
					setActiveIndex(exists)
					return prev
				}
				const next = [...prev, screen]
				setActiveIndex(next.length - 1)
				return next
			})
		},
		[],
	)

	const removeScreen = useCallback(
		(index: number) => {
			setScreens((prev) => {
				if (prev.length <= 1) return prev // Don't remove last screen
				const next = prev.filter((_, i) => i !== index)
				setActiveIndex((ai) => {
					if (ai >= next.length) return next.length - 1
					if (ai > index) return ai - 1
					return ai
				})
				return next
			})
		},
		[],
	)

	const handleCreateSession = useCallback(
		async (description: string) => {
			setGlobalError(null)
			setLoading("Creating session...")
			try {
				const result = await client.createSession(description)
				const session = result.session
				saveSession(session, result.sessionToken)
				setSessions((prev) => [...prev, session])
				addScreen({
					type: "session",
					sessionId: result.sessionId,
					projectName: session.projectName,
				})
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Failed to create session"
				setGlobalError(msg)
			} finally {
				setLoading(null)
			}
		},
		[client, addScreen],
	)

	const handleCreateRoom = useCallback(
		async (description: string) => {
			setGlobalError(null)
			setLoading("Creating room...")
			try {
				const result = await client.createAppRoom(description)
				const sessionTokenMap: Record<string, string> = {}
				for (const s of result.sessions) {
					if (s.sessionToken) sessionTokenMap[s.sessionId] = s.sessionToken
				}
				saveRoom(
					{ id: result.roomId, name: result.name, code: result.code },
					result.roomToken,
					sessionTokenMap,
				)
				setStoredRooms(loadRooms())
				addScreen({
					type: "room",
					roomId: result.roomId,
					roomName: result.name,
				})
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Failed to create room"
				setGlobalError(msg)
			} finally {
				setLoading(null)
			}
		},
		[client, addScreen],
	)

	const handleJoinRoom = useCallback(
		async (code: string) => {
			setGlobalError(null)
			setLoading("Joining room...")
			try {
				const parts = code.split("/")
				if (parts.length !== 2) {
					setGlobalError("Invalid room code format. Use: roomId/code")
					setLoading(null)
					return
				}
				const result = await client.joinAgentRoom(parts[0], parts[1])
				addScreen({
					type: "room",
					roomId: result.id,
					roomName: result.name,
				})
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Failed to join room"
				setGlobalError(msg)
			} finally {
				setLoading(null)
			}
		},
		[client, addScreen],
	)

	const handleSelectSession = useCallback(
		(id: string) => {
			const session = sessions.find((s) => s.id === id)
			addScreen({
				type: "session",
				sessionId: id,
				projectName: session?.projectName,
			})
		},
		[sessions, addScreen],
	)

	const [deletingSessionIds, setDeletingSessionIds] = useState<Set<string>>(new Set())
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
	const confirmDeleteIdRef = useRef(confirmDeleteId)
	confirmDeleteIdRef.current = confirmDeleteId

	const requestDeleteSession = useCallback((sessionId: string) => {
		setConfirmDeleteId(sessionId)
	}, [])

	const cancelDelete = useCallback(() => {
		setConfirmDeleteId(null)
	}, [])

	const confirmDelete = useCallback(
		async (sessionId: string) => {
			setConfirmDeleteId(null)
			setDeletingSessionIds((prev) => new Set(prev).add(sessionId))
			try {
				await client.deleteSession(sessionId)
			} catch {
				// Server may not know about this session — clean up locally regardless
			}
			deleteStoredSession(sessionId)
			setSessions((prev) => prev.filter((s) => s.id !== sessionId))
			setDeletingSessionIds((prev) => {
				const next = new Set(prev)
				next.delete(sessionId)
				return next
			})
			const idx = screensRef.current.findIndex(
				(s) => s.type === "session" && s.sessionId === sessionId,
			)
			if (idx >= 0) removeScreen(idx)
		},
		[client, removeScreen],
	)

	// Global keybindings — stable handler using refs to avoid re-renders
	useInput(useCallback((input: string, key: {
		ctrl: boolean
		meta: boolean
		shift: boolean
		escape: boolean
		leftArrow: boolean
		rightArrow: boolean
		tab: boolean
		return: boolean
		[k: string]: unknown
	}) => {
		const scr = screensRef.current
		const ai = activeIndexRef.current
		const activeScr = scr[ai]

		// ? → toggle help
		if (input === "?" && !key.ctrl && !key.meta) {
			setShowHelp((v) => !v)
			return
		}

		// Ctrl+S → settings
		if (key.ctrl && input === "s") {
			addScreen({ type: "settings" })
			return
		}

		// Ctrl+Q or Ctrl+C → quit
		if (key.ctrl && (input === "q" || input === "c")) {
			exit()
			return
		}

		// Ctrl+N → go to home
		if (key.ctrl && input === "n") {
			setActiveIndex(0)
			return
		}

		// Ctrl+G → open gate overlay
		if (key.ctrl && input === "g") {
			setShowGateOverlay(true)
			return
		}

		// Ctrl+E → toggle console browse mode
		if (key.ctrl && input === "e") {
			if (activeScr?.type === "session") {
				setBrowsing((v) => !v)
			}
			return
		}

		// Ctrl+P → peek (room only)
		if (key.ctrl && input === "p") {
			if (activeScr?.type === "room") {
				setShowPeek(true)
			}
			return
		}

		// Ctrl+D → delete/close current tab (skip if confirm dialog is open)
		if (key.ctrl && input === "d") {
			if (activeScr?.type === "session") {
				requestDeleteSession(activeScr.sessionId)
			} else if (activeScr?.type === "settings" || activeScr?.type === "room") {
				removeScreen(ai)
			}
			return
		}

		// Escape → dismiss help, delete confirm, overlays, or go back from settings
		if (key.escape) {
			if (showHelpRef.current) {
				setShowHelp(false)
				return
			}
			if (confirmDeleteIdRef.current) {
				setConfirmDeleteId(null)
				return
			}
			if (showGateOverlayRef.current) {
				setShowGateOverlay(false)
			} else if (showPeekRef.current) {
				setShowPeek(false)
			} else if (activeScr?.type === "settings") {
				removeScreen(ai)
			}
			return
		}

		// Tab → next tab, Shift+Tab → previous tab
		// Also Ctrl+B/F and Ctrl+Left/Right as alternatives
		if (key.tab) {
			setShowGateOverlay(false)
			setShowPeek(false)
			setBrowsing(false)
			if (key.shift) {
				setActiveIndex((prev) => (prev - 1 + scr.length) % scr.length)
			} else {
				setActiveIndex((prev) => (prev + 1) % scr.length)
			}
			return
		}
		if ((key.ctrl && input === "b") || (key.ctrl && key.leftArrow)) {
			setShowGateOverlay(false)
			setShowPeek(false)
			setActiveIndex((prev) => (prev - 1 + scr.length) % scr.length)
			return
		}
		if ((key.ctrl && input === "f") || (key.ctrl && key.rightArrow)) {
			setShowGateOverlay(false)
			setShowPeek(false)
			setActiveIndex((prev) => (prev + 1) % scr.length)
			return
		}
	}, [addScreen, exit, requestDeleteSession, removeScreen]))

	const tabs: Tab[] = screens.map((screen) => {
		switch (screen.type) {
			case "home":
				return { id: "home", label: "Home" }
			case "session":
				return {
					id: `session-${screen.sessionId}`,
					label: screen.projectName ?? screen.sessionId.slice(0, 8),
					badge: "running" as const,
				}
			case "room":
				return {
					id: `room-${screen.roomId}`,
					label: screen.roomName ?? screen.roomId.slice(0, 8),
					badge: "active" as const,
				}
			case "settings":
				return { id: "settings", label: "Settings" }
		}
	})

	return (
		<Box flexDirection="column">
			{/* Help modal */}
			{showHelp && <HelpModal onClose={() => setShowHelp(false)} />}

			{/* Delete confirmation modal */}
			{confirmDeleteId && (
				<Box flexDirection="column" borderStyle="double" paddingX={2} paddingY={1} marginX={1}>
					<Text bold color="yellow">Delete session?</Text>
					<Box marginTop={1}>
						<Text>This will permanently delete the session and its data.</Text>
					</Box>
					<Box marginTop={1}>
						<SelectInput
							items={[
								{ label: "Delete", value: "delete" },
								{ label: "Cancel", value: "cancel" },
							]}
							onSelect={(item) => {
								if (item.value === "delete") {
									confirmDelete(confirmDeleteId)
								} else {
									cancelDelete()
								}
							}}
						/>
					</Box>
				</Box>
			)}

			{/* Connection warning */}
			{!connected && (
				<Box paddingX={1}>
					<Text color="red">
						{"⚠"} Not connected to {baseUrl} {"—"} start the server or use
						--server
					</Text>
				</Box>
			)}

			{/* Loading indicator */}
			{loading && (
				<Box paddingX={1}>
					<Text color="yellow">{loading}</Text>
				</Box>
			)}

			{/* Global error */}
			{globalError && (
				<Box paddingX={1}>
					<Text color="red">{globalError}</Text>
				</Box>
			)}

			{/* All screens — kept mounted to preserve state, only active one visible */}
			{screens.map((screen, i) => {
				const isActive = i === activeIndex
				return (
					<Box key={screenKey(screen)} flexDirection="column" flexGrow={isActive ? 1 : 0} display={isActive ? "flex" : "none"}>
						{screen.type === "home" && (
							<HomeScreen
								sessions={sessions}
								deletingIds={deletingSessionIds}
								rooms={storedRooms}
								onCreateSession={handleCreateSession}
								onCreateRoom={handleCreateRoom}
								onJoinRoom={handleJoinRoom}
								onSelectSession={handleSelectSession}
								onSelectRoom={(roomId, roomName) => addScreen({ type: "room", roomId, roomName })}
								onDeleteSession={requestDeleteSession}
								isActive={isActive}
								inputDisabled={!!confirmDeleteId}
							/>
						)}
						{screen.type === "session" && (
							<SessionScreen
								client={client}
								sessionId={screen.sessionId}
								projectName={screen.projectName}
								isActive={isActive}
								showGateOverlay={isActive && showGateOverlay}
								browsing={isActive && browsing}
								onGateOverlayDismiss={() => setShowGateOverlay(false)}
								onGateAppeared={() => setShowGateOverlay(true)}
								onBrowseToggle={() => setBrowsing((v) => !v)}
							/>
						)}
						{screen.type === "room" && (
							<RoomScreen
								client={client}
								roomId={screen.roomId}
								roomName={screen.roomName}
								participantName={config.participant.displayName}
								isActive={isActive}
								showPeek={isActive && showPeek}
								onPeekDismiss={() => setShowPeek(false)}
								gateRequested={isActive && showGateOverlay}
								onGateDismissed={() => setShowGateOverlay(false)}
							/>
						)}
						{screen.type === "settings" && (
							<SettingsScreen
								config={config}
								onUpdate={updateConfig}
								isActive={isActive}
								connected={connected}
								keychainStatus={keychainStatus}
							/>
						)}
					</Box>
				)
			})}

			{/* Tab bar */}
			<TabBar tabs={tabs} activeIndex={activeIndex} />
		</Box>
	)
}

function screenKey(screen: Screen): string {
	switch (screen.type) {
		case "home":
			return "home"
		case "session":
			return `session-${screen.sessionId}`
		case "room":
			return `room-${screen.roomId}`
		case "settings":
			return "settings"
	}
}

function storedToSessionInfo(s: StoredSession): SessionInfo {
	return {
		id: s.id,
		projectName: s.projectName,
		sandboxProjectDir: "",
		description: s.description,
		createdAt: s.createdAt,
		lastActiveAt: s.lastActiveAt,
		status: s.status as SessionInfo["status"],
		previewUrl: s.previewUrl,
	}
}
