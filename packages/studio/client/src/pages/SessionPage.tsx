import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom"
import { Console } from "../components/Console"
import { PromptInput } from "../components/PromptInput"
import { Settings } from "../components/Settings"
import { Skeleton } from "../components/Skeleton"
import { useSession } from "../hooks/useSession"
import { useAppContext } from "../layouts/AppShell"
import {
	cancelSession,
	createSession,
	getAppStatus,
	type SessionInfo,
	sendIterate,
} from "../lib/api"
import type { ConsoleEntry } from "../lib/event-types"
import { addSession, getSessionById, updateSession } from "../lib/session-store"

interface OutletCtx {
	openMobileDrawer: () => void
}

type AppState = "hidden" | "starting" | "stopping" | "running" | "stopped"

function serializeEntries(entries: ConsoleEntry[]): string {
	const lines: string[] = []
	for (const entry of entries) {
		switch (entry.kind) {
			case "user_prompt":
				lines.push(`## User\n\n${entry.message}\n`)
				break
			case "assistant_message":
				lines.push(`## Assistant\n\n${entry.text}\n`)
				break
			case "log":
				lines.push(`[${entry.level}] ${entry.message}`)
				break
			case "tool_use": {
				lines.push(`### Tool: ${entry.tool_name}`)
				lines.push("**Input:**")
				lines.push("```json")
				lines.push(JSON.stringify(entry.tool_input, null, 2))
				lines.push("```")
				if (entry.tool_response != null) {
					lines.push("**Output:**")
					lines.push("```")
					lines.push(entry.tool_response)
					lines.push("```")
				}
				lines.push("")
				break
			}
			case "gate":
				if (entry.event.type === "plan_ready") {
					lines.push(`## Plan\n\n${entry.event.plan}\n`)
				} else if (entry.event.type === "clarification_needed") {
					lines.push(`## Clarification Needed\n\n${entry.event.questions.join("\n")}\n`)
				}
				break
		}
	}
	return lines.join("\n")
}

export function SessionPage() {
	const { id } = useParams<{ id: string }>()
	const location = useLocation()
	const navigate = useNavigate()
	const { openMobileDrawer } = useOutletContext<OutletCtx>()
	const {
		showSettings,
		setShowSettings,
		authSource,
		hasGhToken,
		refreshSettings,
		refreshSessions,
	} = useAppContext()
	const [overflowOpen, setOverflowOpen] = useState(false)

	// Close overflow menu when clicking outside
	useEffect(() => {
		if (!overflowOpen) return
		const handleClick = () => setOverflowOpen(false)
		document.addEventListener("click", handleClick)
		return () => document.removeEventListener("click", handleClick)
	}, [overflowOpen])

	// Handle "new" session: create it and replace the URL
	const [initializing, setInitializing] = useState(id === "new")
	const [realSessionId, setRealSessionId] = useState<string | null>(
		id === "new" ? null : (id ?? null),
	)
	const creatingRef = useRef(false)

	// Sync realSessionId when navigating between sessions
	useEffect(() => {
		if (id && id !== "new") {
			setRealSessionId(id)
			setInitializing(false)
			creatingRef.current = false
		}
	}, [id])

	useEffect(() => {
		if (id !== "new" || creatingRef.current) return
		const state = location.state as { description?: string } | null
		if (!state?.description) {
			navigate("/", { replace: true })
			return
		}
		creatingRef.current = true
		setInitializing(true)

		createSession(state.description)
			.then(({ sessionId, session }) => {
				// Save session to localStorage (private to this user)
				addSession(session)
				refreshSessions()
				setRealSessionId(sessionId)
				setInitializing(false)
				navigate(`/session/${sessionId}`, { replace: true })
			})
			.catch((err) => {
				console.error("Failed to create session:", err)
				navigate("/", { replace: true })
			})
	}, [id, location.state, navigate, refreshSessions])

	const effectiveId = realSessionId
	const { entries, isLive, isComplete, appReady, totalCost, markGateResolved } =
		useSession(effectiveId)

	// Load session from localStorage
	const [activeSession, setActiveSession] = useState<SessionInfo | null>(() =>
		effectiveId ? (getSessionById(effectiveId) ?? null) : null,
	)
	const [appState, setAppState] = useState<AppState>("hidden")
	const [appPort, setAppPort] = useState<number | undefined>(() => activeSession?.appPort)
	const [previewUrl, setPreviewUrl] = useState<string | undefined>(() => activeSession?.previewUrl)

	useEffect(() => {
		if (effectiveId) {
			const session = getSessionById(effectiveId)
			setActiveSession(session ?? null)
			if (session?.appPort) setAppPort(session.appPort)
			if (session?.previewUrl) setPreviewUrl(session.previewUrl)
		}
	}, [effectiveId])

	// Update localStorage when session completes
	useEffect(() => {
		if (effectiveId && isComplete) {
			updateSession(effectiveId, { status: "complete" })
			refreshSessions()
		}
	}, [effectiveId, isComplete, refreshSessions])

	// Poll app status when session is complete/error or when Vite reports ready
	const sessionDone =
		isComplete ||
		appReady ||
		activeSession?.status === "complete" ||
		activeSession?.status === "error"

	const appResolved = appState === "running" && !!previewUrl
	useEffect(() => {
		if (!effectiveId || !sessionDone || appResolved) {
			if (!sessionDone) setAppState("hidden")
			return
		}

		const checkStatus = async () => {
			try {
				const status = await getAppStatus(effectiveId)
				setAppState(status.running ? "running" : "stopped")
				if (status.port) setAppPort(status.port)
				if (status.previewUrl) setPreviewUrl(status.previewUrl)
				// Update localStorage with port/preview info
				if (status.port || status.previewUrl) {
					updateSession(effectiveId, {
						...(status.port ? { appPort: status.port } : {}),
						...(status.previewUrl ? { previewUrl: status.previewUrl } : {}),
					})
				}
			} catch {
				setAppState("stopped")
			}
		}
		checkStatus()
		const interval = setInterval(checkStatus, 10_000)
		return () => clearInterval(interval)
	}, [effectiveId, sessionDone, appResolved])

	const handleIterate = useCallback(
		async (request: string) => {
			if (!effectiveId) return
			try {
				await sendIterate(effectiveId, request)
			} catch (err) {
				console.error("Failed to send iteration:", err)
			}
		},
		[effectiveId],
	)

	const handleCancel = useCallback(async () => {
		if (!effectiveId) return
		try {
			await cancelSession(effectiveId)
			updateSession(effectiveId, { status: "cancelled" })
			refreshSessions()
		} catch (err) {
			console.error("Failed to cancel:", err)
		}
	}, [effectiveId, refreshSessions])

	const handleCopyHistory = useCallback(() => {
		const text = serializeEntries(entries)
		navigator.clipboard.writeText(text)
	}, [entries])

	if (!id) return null

	const isRunning = activeSession?.status === "running" && !isComplete

	return (
		<>
			{showSettings && (
				<Settings
					authSource={authSource}
					hasGhToken={hasGhToken ?? false}
					onKeySaved={refreshSettings}
					onClose={() => setShowSettings(false)}
					onCopyLog={effectiveId ? handleCopyHistory : undefined}
				/>
			)}

			<div className="session-header">
				<button
					type="button"
					className="mobile-hamburger"
					onClick={openMobileDrawer}
					aria-label="Open menu"
				>
					<svg
						width="22"
						height="22"
						viewBox="0 0 18 18"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
					>
						<title>Menu</title>
						<line x1="3" y1="4.5" x2="15" y2="4.5" />
						<line x1="3" y1="9" x2="15" y2="9" />
						<line x1="3" y1="13.5" x2="15" y2="13.5" />
					</svg>
				</button>

				<span className="session-header-name">
					{initializing ? "Initializing..." : (activeSession?.projectName ?? "Loading...")}
				</span>

				{isRunning && (
					<span className="session-header-status" style={{ color: "var(--green)" }}>
						Live
					</span>
				)}
				{isComplete && (
					<span className="session-header-status" style={{ color: "var(--text-subtle)" }}>
						Complete
					</span>
				)}
				{!initializing && !isLive && !isComplete && (
					<span className="session-header-status" style={{ color: "var(--yellow)" }}>
						Connecting...
					</span>
				)}

				<span className="session-header-cost">
					{totalCost > 0 && (
						<span style={{ color: "var(--text-subtle)", fontSize: 12, marginLeft: 4 }}>
							${totalCost.toFixed(4)}
						</span>
					)}
				</span>

				<span className="session-header-actions-group">
					{appPort && (appReady || appState === "running" || sessionDone) && (
						<a
							href={previewUrl ?? `http://localhost:${appPort}`}
							target="_blank"
							rel="noopener noreferrer"
							className="session-header-action primary"
						>
							Preview
						</a>
					)}
				</span>

				{/* Mobile overflow menu */}
				<button
					type="button"
					className="session-header-overflow"
					onClick={(e) => {
						e.stopPropagation()
						setOverflowOpen((v) => !v)
					}}
					aria-label="More options"
				>
					<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
						<title>More</title>
						<circle cx="8" cy="3" r="1.5" />
						<circle cx="8" cy="8" r="1.5" />
						<circle cx="8" cy="13" r="1.5" />
					</svg>
				</button>
				{overflowOpen && (
					<div className="session-header-overflow-menu">
						{totalCost > 0 && (
							<div className="session-header-overflow-menu-item">Cost: ${totalCost.toFixed(4)}</div>
						)}
						{appPort && (appReady || appState === "running" || sessionDone) && (
							<a
								href={previewUrl ?? `http://localhost:${appPort}`}
								target="_blank"
								rel="noopener noreferrer"
								className="session-header-overflow-menu-item"
								onClick={() => setOverflowOpen(false)}
							>
								Preview App
							</a>
						)}
						<button
							type="button"
							className="session-header-overflow-menu-item"
							onClick={() => {
								setOverflowOpen(false)
								setShowSettings((v) => !v)
							}}
						>
							Settings
						</button>
					</div>
				)}
			</div>

			{/* Mobile-only preview bar — visible when session is done */}
			{(previewUrl || appPort) && sessionDone && (
				<div className="mobile-preview-bar">
					<a
						href={previewUrl ?? `http://localhost:${appPort}`}
						target="_blank"
						rel="noopener noreferrer"
						className="mobile-preview-link"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<title>Open preview</title>
							<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
							<polyline points="15 3 21 3 21 9" />
							<line x1="10" y1="14" x2="21" y2="3" />
						</svg>
						Open Preview
					</a>
				</div>
			)}

			<div className="session-content">
				{initializing ? (
					<div className="session-initializing">
						<div className="session-initializing-spinner" />
						<span>Setting up your project...</span>
					</div>
				) : !isLive && !isComplete ? (
					<div style={{ padding: 16, flex: 1 }}>
						<Skeleton variant="block" />
						<Skeleton variant="line" width="80%" />
						<Skeleton variant="line" width="60%" />
					</div>
				) : (
					<Console
						sessionId={effectiveId ?? ""}
						entries={entries}
						isLive={isLive}
						isComplete={isComplete}
						onGateResolved={markGateResolved}
					/>
				)}
				<PromptInput
					onSubmit={handleIterate}
					placeholder={
						isRunning ? "Send a follow-up message..." : "Describe changes you want to make..."
					}
					disabled={initializing}
					isRunning={isRunning}
					onCancel={handleCancel}
				/>
			</div>
		</>
	)
}
