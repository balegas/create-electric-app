import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom"
import { Console } from "../components/Console"
import { PromptInput } from "../components/PromptInput"
import { Settings } from "../components/Settings"
import { Skeleton } from "../components/Skeleton"
import { useSession } from "../hooks/useSession"
import { useAppContext } from "../layouts/AppShell"
import { createSession, interruptSession, type SessionInfo, sendIterate } from "../lib/api"
import type { ConsoleEntry } from "../lib/event-types"
import { addSession, getSessionById, updateSession } from "../lib/session-store"

interface OutletCtx {
	openMobileDrawer: () => void
}

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
		devMode,
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
		const state = location.state as { description?: string; freeform?: boolean } | null
		if (!state?.description) {
			navigate("/", { replace: true })
			return
		}
		creatingRef.current = true
		setInitializing(true)

		createSession(state.description, undefined, state.freeform)
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
	const { entries, isLive, isComplete, appStatus, cost, markGateResolved } = useSession(effectiveId)

	// Load session from localStorage
	const [activeSession, setActiveSession] = useState<SessionInfo | null>(() =>
		effectiveId ? (getSessionById(effectiveId) ?? null) : null,
	)

	useEffect(() => {
		if (effectiveId) {
			const session = getSessionById(effectiveId)
			setActiveSession(session ?? null)
		}
	}, [effectiveId])

	// Update localStorage when session completes
	useEffect(() => {
		if (effectiveId && isComplete) {
			updateSession(effectiveId, { status: "complete" })
			refreshSessions()
		}
	}, [effectiveId, isComplete, refreshSessions])

	// Sync needsInput to localStorage so the sidebar avatar ring updates
	// (orange = gate waiting, cyan = running) without waiting for server polling
	const hasUnresolvedGate = entries.some((e) => e.kind === "gate" && !e.resolved)
	useEffect(() => {
		if (!effectiveId) return
		updateSession(effectiveId, { needsInput: hasUnresolvedGate })
		refreshSessions()
	}, [effectiveId, hasUnresolvedGate, refreshSessions])

	// Derive preview URL and port from app_status event
	const appPort = appStatus?.port
	const previewUrl = appStatus?.previewUrl

	const [sendError, setSendError] = useState<string | null>(null)

	const handleIterate = useCallback(
		async (request: string) => {
			if (!effectiveId) return
			setSendError(null)
			try {
				await sendIterate(effectiveId, request)
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Failed to send message"
				setSendError(msg)
			}
		},
		[effectiveId],
	)

	const handleCancel = useCallback(async () => {
		if (!effectiveId) return
		try {
			await interruptSession(effectiveId)
			updateSession(effectiveId, { status: "complete" })
			setActiveSession((prev) => (prev ? { ...prev, status: "complete" } : null))
			refreshSessions()
		} catch (err) {
			console.error("Failed to interrupt:", err)
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
					devMode={devMode}
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
				{!initializing && !isLive && !isComplete && (
					<span className="session-header-status" style={{ color: "var(--yellow)" }}>
						Connecting...
					</span>
				)}

				{cost.totalCostUsd > 0 && (
					<span className="session-header-cost" title={`${cost.totalTurns} turns`}>
						${cost.totalCostUsd.toFixed(2)}
					</span>
				)}

				{/* Mobile icon-only Open App button */}
				{appStatus && (previewUrl || appPort) && (
					<a
						href={previewUrl ?? `http://localhost:${appPort}`}
						target="_blank"
						rel="noopener noreferrer"
						className={`mobile-open-app-icon ${appStatus.status === "running" ? "primary" : ""}`}
						aria-label="Open App"
					>
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<title>Open App</title>
							<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
							<polyline points="15 3 21 3 21 9" />
							<line x1="10" y1="14" x2="21" y2="3" />
						</svg>
					</a>
				)}

				<span className="session-header-actions-group">
					{appStatus && (
						<a
							href={previewUrl ?? (appPort ? `http://localhost:${appPort}` : "#")}
							target="_blank"
							rel="noopener noreferrer"
							className={`session-header-action ${appStatus.status === "running" ? "primary" : ""}`}
						>
							Open App
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
						{cost.totalCostUsd > 0 && (
							<span className="session-header-overflow-menu-item session-header-overflow-cost">
								Cost: ${cost.totalCostUsd.toFixed(2)} ({cost.totalTurns} turns)
							</span>
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

			<div className="session-content">
				{initializing ? (
					<div className="session-initializing">
						<div className="session-initializing-spinner" />
						<span>Setting up your project...</span>
					</div>
				) : !isLive && !isComplete ? (
					<div className="session-loading">
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
				{sendError && (
					<div className="room-send-error">
						{sendError}
						<button type="button" onClick={() => setSendError(null)}>
							&times;
						</button>
					</div>
				)}
				<PromptInput
					onSubmit={handleIterate}
					placeholder={isRunning ? "Message..." : "Ask anything..."}
					disabled={initializing}
					isRunning={isRunning}
					onCancel={handleCancel}
				/>
			</div>
		</>
	)
}
