import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router-dom"
import { Console } from "../components/Console"
import { GitControls } from "../components/GitControls"
import { PromptInput } from "../components/PromptInput"
import { RightPanel } from "../components/RightPanel"
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

type AppState = "hidden" | "starting" | "stopping" | "running" | "stopped"

function serializeEntries(entries: ConsoleEntry[]): string {
	const lines: string[] = []
	for (const entry of entries) {
		switch (entry.kind) {
			case "user_message":
				lines.push(`## User\n\n${entry.message}\n`)
				break
			case "text":
				lines.push(`## Assistant\n\n${entry.text}\n`)
				break
			case "log":
				lines.push(`[${entry.level}] ${entry.message}`)
				break
			case "tool": {
				lines.push(`### Tool: ${entry.toolName}`)
				lines.push("**Input:**")
				lines.push("```json")
				lines.push(JSON.stringify(entry.input, null, 2))
				lines.push("```")
				if (entry.output != null) {
					lines.push("**Output:**")
					lines.push("```")
					lines.push(entry.output)
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
	const {
		sessions,
		showSettings,
		setShowSettings,
		hasApiKey,
		hasGhToken,
		refreshSettings,
		refreshSessions,
	} = useAppContext()

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
			.then(async ({ sessionId, appPort: port }) => {
				if (port) setAppPort(port)
				await refreshSessions()
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

	const [activeSession, setActiveSession] = useState<SessionInfo | null>(null)
	const [appState, setAppState] = useState<AppState>("hidden")
	const [appPort, setAppPort] = useState<number | undefined>(
		() => sessions.find((s) => s.id === effectiveId)?.appPort,
	)
	const [rightPanelCollapsed, setRightPanelCollapsed] = useState(() => {
		const saved = localStorage.getItem("rightPanelCollapsed")
		return saved === null ? true : saved === "true"
	})
	const [splitPercent, setSplitPercent] = useState(50)
	const layoutRef = useRef<HTMLDivElement>(null)
	const dragging = useRef(false)

	const handleDragStart = useCallback((e: React.MouseEvent) => {
		e.preventDefault()
		dragging.current = true
		document.body.style.cursor = "col-resize"
		document.body.style.userSelect = "none"

		const onMove = (ev: MouseEvent) => {
			if (!dragging.current || !layoutRef.current) return
			const rect = layoutRef.current.getBoundingClientRect()
			const pct = ((ev.clientX - rect.left) / rect.width) * 100
			setSplitPercent(Math.min(80, Math.max(20, pct)))
		}
		const onUp = () => {
			dragging.current = false
			document.body.style.cursor = ""
			document.body.style.userSelect = ""
			document.removeEventListener("mousemove", onMove)
			document.removeEventListener("mouseup", onUp)
		}
		document.addEventListener("mousemove", onMove)
		document.addEventListener("mouseup", onUp)
	}, [])

	useEffect(() => {
		if (effectiveId) {
			const session = sessions.find((s) => s.id === effectiveId)
			setActiveSession(session ?? null)
			if (session?.appPort) setAppPort(session.appPort)
		}
	}, [effectiveId, sessions])

	// Poll app status when session is complete/error or when Vite reports ready
	const sessionDone =
		isComplete ||
		appReady ||
		activeSession?.status === "complete" ||
		activeSession?.status === "error"

	useEffect(() => {
		if (!effectiveId || !sessionDone) {
			setAppState("hidden")
			return
		}

		const checkStatus = async () => {
			try {
				const status = await getAppStatus(effectiveId)
				setAppState(status.running ? "running" : "stopped")
				if (status.port) setAppPort(status.port)
			} catch {
				setAppState("stopped")
			}
		}
		checkStatus()
		const interval = setInterval(checkStatus, 10_000)
		return () => clearInterval(interval)
	}, [effectiveId, sessionDone])

	const handleIterate = useCallback(
		async (request: string) => {
			if (!effectiveId) return
			try {
				await sendIterate(effectiveId, request)
				await refreshSessions()
			} catch (err) {
				console.error("Failed to send iteration:", err)
			}
		},
		[effectiveId, refreshSessions],
	)

	const handleCancel = useCallback(async () => {
		if (!effectiveId) return
		try {
			await cancelSession(effectiveId)
			await refreshSessions()
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
			{showSettings && hasApiKey !== null && (
				<Settings
					hasApiKey={hasApiKey}
					hasGhToken={hasGhToken ?? false}
					onKeySaved={refreshSettings}
					onClose={() => setShowSettings(false)}
					onCopyLog={effectiveId ? handleCopyHistory : undefined}
				/>
			)}

			<div className="session-header">
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

				{totalCost > 0 && (
					<span style={{ color: "var(--text-subtle)", fontSize: 12, marginLeft: 4 }}>
						${totalCost.toFixed(4)}
					</span>
				)}

				{appPort && (appReady || appState === "running" || sessionDone) && (
					<a
						href={`http://localhost:${appPort}`}
						target="_blank"
						rel="noopener noreferrer"
						className="session-header-action primary"
					>
						Preview
					</a>
				)}

				{activeSession && sessionDone && (
					<GitControls
						sessionId={effectiveId ?? ""}
						gitState={activeSession.git}
						onUpdate={refreshSessions}
					/>
				)}
			</div>

			<div
				ref={layoutRef}
				className={`session-layout ${rightPanelCollapsed ? "right-collapsed" : ""}`}
				style={
					rightPanelCollapsed ? undefined : { gridTemplateColumns: `${splitPercent}% 4px 1fr` }
				}
			>
				<div className="session-left">
					{initializing ? (
						<div className="session-initializing">
							<div className="session-initializing-spinner" />
							<span>Setting up your project...</span>
						</div>
					) : !isLive && !isComplete ? (
						<div style={{ padding: 16 }}>
							<Skeleton variant="block" />
							<Skeleton variant="line" width="80%" />
							<Skeleton variant="line" width="60%" />
						</div>
					) : (
						<Console
							sessionId={effectiveId ?? ""}
							entries={entries}
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
				<div
					className={`session-divider ${rightPanelCollapsed ? "collapsed" : ""}`}
					onMouseDown={rightPanelCollapsed ? undefined : handleDragStart}
				>
					<button
						type="button"
						className="session-divider-toggle"
						onClick={() =>
							setRightPanelCollapsed((v) => {
								const next = !v
								localStorage.setItem("rightPanelCollapsed", String(next))
								return next
							})
						}
						title={rightPanelCollapsed ? "Show code panel" : "Hide code panel"}
					>
						<svg
							viewBox="0 0 8 14"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
						>
							<title>{rightPanelCollapsed ? "Expand" : "Collapse"}</title>
							{rightPanelCollapsed ? (
								<polyline points="6,1 1,7 6,13" />
							) : (
								<polyline points="2,1 7,7 2,13" />
							)}
						</svg>
					</button>
				</div>
				{!rightPanelCollapsed && (
					<div className="session-right">
						<RightPanel sessionId={effectiveId ?? ""} entries={entries} />
					</div>
				)}
			</div>
		</>
	)
}
