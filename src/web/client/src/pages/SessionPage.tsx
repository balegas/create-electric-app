import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router-dom"
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

				<button
					type="button"
					className="session-header-settings"
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

			<div className="session-content">
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
		</>
	)
}
