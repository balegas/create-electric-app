import { useCallback, useEffect, useState } from "react"
import { Console } from "./components/Console"
import { PromptInput } from "./components/PromptInput"
import { useSession } from "./hooks/useSession"
import {
	cancelSession,
	createSession,
	listSessions,
	type SessionInfo,
	sendIterate,
} from "./lib/api"

export function App() {
	const [sessions, setSessions] = useState<SessionInfo[]>([])
	const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
	const [activeSession, setActiveSession] = useState<SessionInfo | null>(null)
	const [loading, setLoading] = useState(false)

	const { entries, isLive, isComplete, markGateResolved } = useSession(activeSessionId)

	// Load sessions on mount
	useEffect(() => {
		listSessions()
			.then((data) => setSessions(data.sessions))
			.catch(() => {})
	}, [])

	// Track active session info
	useEffect(() => {
		if (activeSessionId) {
			const session = sessions.find((s) => s.id === activeSessionId)
			setActiveSession(session ?? null)
		}
	}, [activeSessionId, sessions])

	const handleNewProject = useCallback(async (description: string) => {
		setLoading(true)
		try {
			const { sessionId } = await createSession(description)
			setActiveSessionId(sessionId)
			// Refresh sessions list
			const data = await listSessions()
			setSessions(data.sessions)
		} catch (err) {
			console.error("Failed to create session:", err)
		} finally {
			setLoading(false)
		}
	}, [])

	const handleIterate = useCallback(
		async (request: string) => {
			if (!activeSessionId) return
			try {
				// Sending a new iteration while running will auto-abort the current run server-side
				await sendIterate(activeSessionId, request)
				// Refresh session list to pick up status change
				const data = await listSessions()
				setSessions(data.sessions)
			} catch (err) {
				console.error("Failed to send iteration:", err)
			}
		},
		[activeSessionId],
	)

	const handleCancel = useCallback(async () => {
		if (!activeSessionId) return
		try {
			await cancelSession(activeSessionId)
			const data = await listSessions()
			setSessions(data.sessions)
		} catch (err) {
			console.error("Failed to cancel:", err)
		}
	}, [activeSessionId])

	// No active session — show creation UI
	if (!activeSessionId) {
		return (
			<div className="app">
				<div className="header">
					<h1>Electric Agent</h1>
				</div>

				{sessions.length > 0 && (
					<div style={{ padding: "16px 0", borderBottom: "1px solid var(--border)" }}>
						<div
							style={{
								fontSize: 12,
								color: "var(--text-subtle)",
								textTransform: "uppercase",
								letterSpacing: "0.05em",
								marginBottom: 8,
							}}
						>
							Recent sessions
						</div>
						{sessions
							.slice()
							.reverse()
							.slice(0, 10)
							.map((s) => (
								<div
									key={s.id}
									onClick={() => setActiveSessionId(s.id)}
									style={{
										padding: "8px 12px",
										cursor: "pointer",
										borderRadius: 6,
										marginBottom: 2,
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
									}}
									onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
									onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
								>
									<div>
										<span style={{ fontWeight: 600 }}>{s.projectName}</span>
										<span style={{ color: "var(--text-muted)", marginLeft: 8 }}>
											{s.description.slice(0, 60)}
											{s.description.length > 60 ? "..." : ""}
										</span>
									</div>
									<span
										style={{
											fontSize: 11,
											padding: "2px 8px",
											borderRadius: 10,
											background:
												s.status === "complete"
													? "var(--green)"
													: s.status === "running"
														? "var(--cyan)"
														: s.status === "error"
															? "var(--red)"
															: "var(--text-subtle)",
											color: "var(--bg)",
										}}
									>
										{s.status}
									</span>
								</div>
							))}
					</div>
				)}

				<div className="empty-state">
					<h2>Create a new project</h2>
					<p>Describe the application you want to build</p>
				</div>

				<PromptInput
					onSubmit={handleNewProject}
					placeholder="Describe the application you want to build..."
					disabled={loading}
				/>
			</div>
		)
	}

	// Active session — show console
	const isRunning = activeSession?.status === "running" && !isComplete

	return (
		<div className="app">
			<div className="header">
				<h1>Electric Agent</h1>
				<span style={{ color: "var(--text-muted)", fontSize: 13 }}>
					{activeSession?.projectName}
				</span>
				<div className="status">
					{isRunning && (
						<>
							<span style={{ color: "var(--green)" }}>Live</span>
							{" | "}
							<span onClick={handleCancel} style={{ color: "var(--red)", cursor: "pointer" }}>
								Cancel
							</span>
						</>
					)}
					{isComplete && <span style={{ color: "var(--text-subtle)" }}>Complete</span>}
					{!isLive && !isComplete && <span style={{ color: "var(--yellow)" }}>Connecting...</span>}
				</div>
				<span
					onClick={() => setActiveSessionId(null)}
					style={{
						color: "var(--text-subtle)",
						cursor: "pointer",
						fontSize: 13,
						marginLeft: 8,
					}}
				>
					Back
				</span>
			</div>

			<Console sessionId={activeSessionId} entries={entries} onGateResolved={markGateResolved} />

			<PromptInput
				onSubmit={handleIterate}
				placeholder={
					isRunning
						? "Send a message to start a new iteration (aborts current run)..."
						: "Describe changes you want to make..."
				}
				disabled={false}
			/>
		</div>
	)
}
