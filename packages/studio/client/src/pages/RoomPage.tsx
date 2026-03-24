import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom"
import { AskUserQuestionGate, InfraConfigGate } from "../components/GatePrompt"
import { Markdown } from "../components/Markdown"
import { getAvatarColor } from "../components/SessionListItem"
import { type RoomEvent, useRoomEvents } from "../hooks/useRoomEvents"
import { useAppContext } from "../layouts/AppShell"
import { addAgentRoom, getAgentRooms } from "../lib/agent-room-store"
import {
	addAgentToRoom,
	createAppRoom,
	fetchGhAccounts,
	getAgentRoomState,
	joinAgentRoom,
	respondToRoomGate,
	type RoomState,
	sendRoomMessage,
} from "../lib/api"
import { getGhToken } from "../lib/credentials"
import { getOrCreateParticipant } from "../lib/participant"
import { addSession, setSessionToken, updateSession } from "../lib/session-store"

interface OutletCtx {
	openMobileDrawer: () => void
}

export function RoomPage() {
	const { id: roomId } = useParams<{ id: string }>()
	const navigate = useNavigate()
	const location = useLocation()
	const { openMobileDrawer } = useOutletContext<OutletCtx>()
	const { refreshSessions, refreshAgentRooms, hasGhToken } = useAppContext()
	const [roomState, setRoomState] = useState<RoomState | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [showAddAgent, setShowAddAgent] = useState(false)
	const [sending, setSending] = useState(false)
	const [infraGateResolved, setInfraGateResolved] = useState(false)
	const [ghAccounts, setGhAccounts] = useState<Array<{ login: string; type: string }>>([])
	const [searchParams, setSearchParams] = useSearchParams()

	// Auto-join when ?code= query param is present (e.g. /room/:id?code=xyz)
	useEffect(() => {
		const code = searchParams.get("code")
		if (!code || !roomId || roomId === "new") return
		// Already joined? Check local store
		if (getAgentRooms().some((r) => r.id === roomId)) {
			// Remove code from URL
			setSearchParams({}, { replace: true })
			return
		}
		joinAgentRoom(roomId, code)
			.then((result) => {
				// Build sessions map for sidebar display
				const findSession = (role: string) => result.sessions?.find((s) => s.role === role)?.sessionId
				addAgentRoom({
					id: result.id,
					code,
					name: result.name,
					createdAt: new Date().toISOString(),
					sessions: findSession("coder")
						? {
								coder: findSession("coder")!,
								reviewer: findSession("reviewer") ?? "",
								uiDesigner: findSession("ui-designer"),
							}
						: undefined,
				})
				// Store agent session tokens so we can respond to gates, iterate, etc.
				if (result.sessions) {
					for (const s of result.sessions) {
						if (s.sessionToken) {
							setSessionToken(s.sessionId, s.sessionToken)
						}
						addSession({
							id: s.sessionId,
							projectName: s.name,
							sandboxProjectDir: "",
							description: `Room agent: ${s.name} (${s.role ?? "agent"})`,
							createdAt: new Date().toISOString(),
							lastActiveAt: new Date().toISOString(),
							status: "running",
						})
					}
				}
				refreshAgentRooms()
				refreshSessions()
				// Remove code from URL so refresh doesn't re-join
				setSearchParams({}, { replace: true })
			})
			.catch((err) => {
				console.error("[room] Auto-join failed:", err)
				setError(err instanceof Error ? err.message : "Failed to join room")
			})
	}, [roomId, searchParams, setSearchParams, refreshAgentRooms])

	// Fetch GitHub accounts when there's a pending infra gate and user has a GH token
	useEffect(() => {
		const ghToken = getGhToken()
		console.log("[room] GH accounts effect:", {
			pendingGate: !!roomState?.pendingInfraGate,
			infraGateResolved,
			hasGhToken,
			ghTokenPresent: !!ghToken,
		})
		if (!roomState?.pendingInfraGate || infraGateResolved) return
		if (!ghToken) return
		console.log("[room] Fetching GH accounts...")
		fetchGhAccounts()
			.then((accounts) => {
				console.log("[room] GH accounts fetched:", accounts)
				setGhAccounts(accounts)
			})
			.catch((err) => {
				console.error("[room] GH accounts fetch failed:", err)
			})
	}, [roomState?.pendingInfraGate, infraGateResolved, hasGhToken])
	const loadedRef = useRef(false)

	// Handle /room/new — create a multi-agent app room
	useEffect(() => {
		if (roomId !== "new") return
		const state = location.state as { description?: string } | null
		const description = state?.description
		if (!description) {
			navigate("/", { replace: true })
			return
		}

		let cancelled = false
		createAppRoom(description)
			.then((result) => {
				if (cancelled) return
				const findSession = (role: string) => {
					const s = result.sessions?.find((s) => s.role === role)
					if (!s) throw new Error(`Server did not return expected role: ${role}`)
					return s.sessionId
				}
				// Store room in localStorage for sidebar
				const findOptionalSession = (role: string) => {
					const s = result.sessions?.find((s) => s.role === role)
					return s?.sessionId
				}
				addAgentRoom({
					id: result.roomId,
					code: result.code,
					name: result.name,
					createdAt: new Date().toISOString(),
					sessions: {
						coder: findSession("coder"),
						reviewer: findSession("reviewer"),
						uiDesigner: findOptionalSession("ui-designer"),
					},
				})
				// Store each agent session in localStorage for sidebar display
				for (const s of result.sessions) {
					addSession({
						id: s.sessionId,
						projectName: s.name,
						sandboxProjectDir: "",
						description: `Room agent: ${s.name} (${s.role})`,
						createdAt: new Date().toISOString(),
						lastActiveAt: new Date().toISOString(),
						status: "running",
					})
				}
				refreshSessions()
				refreshAgentRooms()
				navigate(`/room/${result.roomId}`, { replace: true })
			})
			.catch((err) => {
				if (cancelled) return
				setError(err instanceof Error ? err.message : "Failed to create room")
			})

		return () => {
			cancelled = true
		}
	}, [roomId, location.state, navigate, refreshSessions, refreshAgentRooms])

	const { events, isClosed } = useRoomEvents(roomId && roomId !== "new" ? roomId : null)

	// Look up invite code from the local room store
	const roomEntry = roomId ? getAgentRooms().find((r) => r.id === roomId) : undefined

	// Fetch room state on mount + periodically
	useEffect(() => {
		if (!roomId || roomId === "new") return
		let cancelled = false
		loadedRef.current = false
		const fetchState = () => {
			getAgentRoomState(roomId)
				.then((state) => {
					if (!cancelled) {
						loadedRef.current = true
						setRoomState(state)
						setError(null)
						// Sync participant status + tokens to localStorage
						for (const p of state.participants) {
							// Store session token so we can respond to gates
							if (p.sessionToken) {
								setSessionToken(p.sessionId, p.sessionToken)
							}
							// Upsert session in sidebar
							addSession({
								id: p.sessionId,
								projectName: p.name,
								sandboxProjectDir: "",
								description: `Room agent: ${p.name} (${p.role ?? "agent"})`,
								createdAt: new Date().toISOString(),
								lastActiveAt: new Date().toISOString(),
								status: p.running ? "running" : "complete",
								needsInput: p.needsInput,
							})
						}
						// Also track pending sessions (still provisioning)
						if (state.pendingSessions) {
							for (const s of state.pendingSessions) {
								if (s.sessionToken) {
									setSessionToken(s.sessionId, s.sessionToken)
								}
								addSession({
									id: s.sessionId,
									projectName: s.name,
									sandboxProjectDir: "",
									description: `Room agent: ${s.name} (${s.role ?? "agent"}) — provisioning`,
									createdAt: new Date().toISOString(),
									lastActiveAt: new Date().toISOString(),
									status: "running",
								})
							}
						}
						// Update room entry with sessions map for sidebar
						const findSession = (role: string) =>
							state.participants.find((p) => p.role === role)?.sessionId
								?? state.pendingSessions?.find((s) => s.role === role)?.sessionId
						const coderId = findSession("coder")
						if (coderId) {
							const existing = getAgentRooms().find((r) => r.id === roomId)
							if (existing && !existing.sessions?.coder) {
								addAgentRoom({
									...existing,
									sessions: {
										coder: coderId,
										reviewer: findSession("reviewer") ?? "",
										uiDesigner: findSession("ui-designer"),
									},
								})
								refreshAgentRooms()
							}
						}
						refreshSessions()
					}
				})
				.catch((err) => {
					if (!cancelled) {
						const msg = err instanceof Error ? err.message : String(err)
						// Always show "not found" errors even if we loaded before
						if (msg.includes("not found") || msg.includes("Not Found")) {
							setError(msg)
						} else if (!loadedRef.current) {
							setError(msg)
						}
					}
				})
		}
		fetchState()
		const interval = setInterval(fetchState, 5000)
		return () => {
			cancelled = true
			clearInterval(interval)
		}
	}, [roomId, refreshSessions])

	if (roomId === "new") {
		return (
			<div className="room-empty">
				<div className="waiting-indicator">
					<span className="spinner-inline" />
					<span className="waiting-label">Setting up</span>
				</div>
			</div>
		)
	}

	if (error) {
		return (
			<div className="room-error">
				<h2>Error</h2>
				<p>{error}</p>
				<button type="button" className="btn" onClick={() => navigate("/")}>
					Go Home
				</button>
			</div>
		)
	}

	const effectiveState = isClosed ? "closed" : roomState?.state
	const participants = roomState?.participants ?? []
	const appUrl =
		roomState?.previewUrl ??
		(roomState?.appPort ? `http://localhost:${roomState.appPort}` : undefined)
	const pendingInfraGate = roomState?.pendingInfraGate

	return (
		<>
			<RoomHeader
				roomId={roomId}
				roomName={roomEntry?.name}
				roomCode={roomEntry?.code}
				state={effectiveState}
				participants={participants}
				appUrl={appUrl}
				onAddAgent={() => setShowAddAgent(true)}
				openMobileDrawer={openMobileDrawer}
			/>

			<div className="session-content">
				<div className="room-messages">
					<RoomEventList
						roomId={roomId ?? ""}
						events={events}
						participants={participants}
						provisioning={!!roomEntry?.sessions && participants.length < 3}
					/>
					{pendingInfraGate && !infraGateResolved && (
						<div style={{ padding: "0 16px 16px" }}>
							<InfraConfigGate
								sessionId={pendingInfraGate.sessionId}
								event={{
									type: "infra_config_prompt" as const,
									projectName: pendingInfraGate.projectName,
									ghAccounts,
									runtime: pendingInfraGate.runtime,
									ts: new Date().toISOString(),
								}}
								onResolved={() => setInfraGateResolved(true)}
							/>
						</div>
					)}
				</div>

				<RoomInput
					roomId={roomId ?? ""}
					participants={participants}
					disabled={effectiveState === "closed" || sending}
					sending={sending}
					setSending={setSending}
				/>
			</div>

			{showAddAgent && roomId && (
				<AddAgentModal
					roomId={roomId}
					onClose={() => setShowAddAgent(false)}
					onAdded={() => {
						setShowAddAgent(false)
						refreshSessions()
						// Refresh state to get updated participant list
						getAgentRoomState(roomId)
							.then(setRoomState)
							.catch(() => {})
					}}
				/>
			)}
		</>
	)
}

function RoomHeader({
	roomId,
	roomName,
	roomCode,
	state,
	participants,
	appUrl,
	onAddAgent,
	openMobileDrawer,
}: {
	roomId?: string
	roomName?: string
	roomCode?: string
	state?: string
	participants: Array<{ sessionId: string; name: string; role?: string; running?: boolean }>
	appUrl?: string
	onAddAgent: () => void
	openMobileDrawer: () => void
}) {
	const navigate = useNavigate()
	const [copied, setCopied] = useState(false)

	const handleCopyCode = useCallback(() => {
		if (!roomId || !roomCode) return
		const joinToken = `${roomId}:${roomCode}`
		navigator.clipboard.writeText(joinToken)
		setCopied(true)
		setTimeout(() => setCopied(false), 2000)
	}, [roomId, roomCode])

	return (
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

			<span className="session-header-name">{roomName || roomId?.slice(0, 8)}</span>

			{state === "active" && (
				<span className="session-header-status" style={{ color: "var(--purple)" }}>
					Active
				</span>
			)}
			{state === "interrupted" && (
				<span className="session-header-status" style={{ color: "var(--yellow)" }}>
					Interrupted
				</span>
			)}
			{state === "closed" && (
				<span className="session-header-status" style={{ color: "var(--text-subtle)" }}>
					Closed
				</span>
			)}

			<span className="room-header-participants">
				{participants.map((p) => {
					const color = getAvatarColor(p.sessionId)
					const initials = p.name
						.split(/[-_ ]+/)
						.slice(0, 2)
						.map((w) => w.charAt(0).toUpperCase())
						.join("")
					return (
						<button
							key={p.sessionId}
							type="button"
							className="room-header-avatar"
							style={{ background: color.bg, color: color.fg }}
							title={p.name}
							onClick={() => navigate(`/session/${p.sessionId}`)}
						>
							{initials}
						</button>
					)
				})}
			</span>

			{roomCode && (
				<>
					<span className="invite-code-label">Join code:</span>
					<button type="button" className="invite-code-btn" onClick={handleCopyCode}>
						{copied ? "Copied!" : roomCode}
					</button>
				</>
			)}

			{/* Mobile icon-only Open App button */}
			{appUrl && (
				<a
					href={appUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="mobile-open-app-icon primary"
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
				<button
					type="button"
					className="session-header-action"
					onClick={onAddAgent}
					disabled={state === "closed"}
				>
					Add Agent
				</button>
				{appUrl && (
					<a
						href={appUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="session-header-action primary"
					>
						Open App
					</a>
				)}
			</span>
		</div>
	)
}

function RoomParticipantPrefix({
	name,
	participants,
}: {
	name: string
	participants: Array<{ sessionId: string; name: string; role?: string; running?: boolean }>
}) {
	const navigate = useNavigate()
	const participant = participants.find((p) => p.name === name)
	if (!participant) return <span className="prefix task">[{name}]</span>
	const color = getAvatarColor(participant.sessionId)
	return (
		<button
			type="button"
			className="prefix task room-prefix-link"
			style={{ color: color.fg }}
			onClick={() => navigate(`/session/${participant.sessionId}`)}
			title={`Go to ${name}'s session`}
		>
			[{name}]
		</button>
	)
}

/** Inline clickable agent name (no brackets, used inside system messages) */
function AgentNameLink({
	name,
	participants,
}: {
	name: string
	participants: Array<{ sessionId: string; name: string; role?: string }>
}) {
	const navigate = useNavigate()
	const participant = participants.find((p) => p.name === name)
	if (!participant) return <span>{name}</span>
	const color = getAvatarColor(participant.sessionId)
	return (
		<button
			type="button"
			className="room-prefix-link"
			style={{ color: color.fg, fontWeight: 600 }}
			onClick={() => navigate(`/session/${participant.sessionId}`)}
			title={`Go to ${name}'s session`}
		>
			{name}
		</button>
	)
}

/** Render system message body with agent names as clickable links */
function SystemMessageBody({
	body,
	participants,
}: {
	body: string
	participants: Array<{ sessionId: string; name: string; role?: string }>
}) {
	if (participants.length === 0) return <span>{body}</span>

	// Build regex matching any participant name
	const escaped = participants.map((p) => p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
	const pattern = new RegExp(`(${escaped.join("|")})`, "g")
	const parts = body.split(pattern)

	return (
		<span>
			{parts.map((part, i) => {
				const p = participants.find((pp) => pp.name === part)
				if (p) return <AgentNameLink key={i} name={part} participants={participants} />
				return <span key={i}>{part}</span>
			})}
		</span>
	)
}

function RoomEventList({
	roomId,
	events,
	participants,
	provisioning,
}: {
	roomId: string
	events: RoomEvent[]
	participants: Array<{
		sessionId: string
		name: string
		role?: string
		running?: boolean
		needsInput?: boolean
	}>
	provisioning?: boolean
}) {
	const bottomRef = useRef<HTMLDivElement>(null)
	const workingAgents = participants.filter((p) => p.running && !p.needsInput)

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" })
	}, [events.length, workingAgents.length])

	if (events.length === 0) {
		return (
			<div className="room-empty">
				{provisioning ? (
					<div className="waiting-indicator">
						<span className="spinner-inline" />
						<span className="waiting-label">Setting up agents</span>
					</div>
				) : (
					<p>No messages yet.</p>
				)}
			</div>
		)
	}

	return (
		<div className="room-event-list">
			{events.map((event, i) => {
				const key = `${event.ts}-${i}`
				const time = (
					<span key={`t-${key}`} className="duration" style={{ whiteSpace: "nowrap" }}>
						{new Date(event.ts).toLocaleTimeString()}
					</span>
				)
				switch (event.type) {
					case "agent_message":
						if (event.from === "system") {
							if (event.body.includes("Project ready")) return null
							if (event.body.startsWith("Infrastructure confirmed")) {
								// Parse "Infrastructure confirmed — Key1: Val1, Key2: Val2"
								const detailStr = event.body.replace(/^Infrastructure confirmed —\s*/, "")
								const details = detailStr
									.split(", ")
									.reduce<Record<string, string>>((acc, part) => {
										const idx = part.indexOf(": ")
										if (idx > 0) acc[part.slice(0, idx)] = part.slice(idx + 2)
										return acc
									}, {})
								return (
									<div key={key} style={{ padding: "8px 0" }}>
										<div className="gate-prompt">
											<div className="gate-config-summary">
												{Object.entries(details).map(([k, v]) => (
													<div key={k}>
														<strong>{k}:</strong>{" "}
														{v.startsWith("http") ? (
															<a href={v} target="_blank" rel="noopener noreferrer">
																{v}
															</a>
														) : (
															v
														)}
													</div>
												))}
											</div>
										</div>
									</div>
								)
							}
							return (
								<div key={key} className="console-entry">
									<span className="prefix" style={{ color: "var(--orange)" }}>
										[system]
									</span>
									<SystemMessageBody body={event.body} participants={participants} />
									{time}
								</div>
							)
						}
						if (event.body.length <= 300) {
							return (
								<div key={key} className="console-entry">
									<RoomParticipantPrefix name={event.from} participants={participants} />
									{event.to && (
										<>
											<span className="room-message-arrow">&rarr;</span>
											<RoomParticipantPrefix name={event.to} participants={participants} />
										</>
									)}
									<span>{event.body}</span>
									{time}
								</div>
							)
						}
						return (
							<details key={key} className="tool-inline">
								<summary>
									<RoomParticipantPrefix name={event.from} participants={participants} />
									{event.to && (
										<>
											<span className="room-message-arrow">&rarr;</span>
											<RoomParticipantPrefix name={event.to} participants={participants} />
										</>
									)}
									<span className="tool-inline-summary">{`${event.body.slice(0, 300)}...`}</span>
									{time}
								</summary>
								<div className="tool-inline-body">
									<Markdown>{event.body}</Markdown>
								</div>
							</details>
						)
					case "participant_joined": {
						const joinedName = event.participant?.displayName ?? "Unknown"
						const joinedP = participants.find((p) => p.name === joinedName)
						const roleLabel = joinedP?.role ? ` (${joinedP.role})` : ""
						return (
							<div key={key} className="console-entry">
								<span className="prefix" style={{ color: "var(--orange)" }}>
									[system]
								</span>
								<span>
									<AgentNameLink name={joinedName} participants={participants} />
									{roleLabel} joined
								</span>
								{time}
							</div>
						)
					}
					case "participant_left":
						return (
							<div key={key} className="console-entry">
								<span className="prefix" style={{ color: "var(--orange)" }}>
									[system]
								</span>
								<span>Participant left</span>
							</div>
						)
					case "room_closed":
						return (
							<div key={key} className="console-entry">
								<span className="prefix" style={{ color: "var(--orange)" }}>
									[system]
								</span>
								<span>
									Closed by {event.closedBy}
									{event.summary && <> — {event.summary}</>}
								</span>
							</div>
						)
					case "agent_activity": {
						const isGate = event.eventType === "ask_user_question"
						if (isGate && event.gateData) {
							const gd = event.gateData as {
								sessionId: string
								toolUseId: string
								questions: Array<{ question: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean }>
							}
							return (
								<div key={key} className="agent-gate-activity">
									<div className="console-entry">
										<RoomParticipantPrefix name={event.from} participants={participants} />
										<span className="agent-gate-question">needs input</span>
										{time}
									</div>
									<AskUserQuestionGate
										sessionId={gd.sessionId}
										event={{
											type: "ask_user_question" as const,
											tool_use_id: gd.toolUseId,
											questions: gd.questions,
											ts: event.ts,
										}}
										onResolved={() => {}}
										respondFn={(sid, gate, data) =>
											respondToRoomGate(roomId ?? "", sid, gate, data)
										}
									/>
								</div>
							)
						}
						return (
							<div
								key={key}
								className={`console-entry ${isGate ? "agent-gate-activity" : "agent-activity"}`}
							>
								<RoomParticipantPrefix name={event.from} participants={participants} />
								{isGate ? (
									<span className="agent-gate-question">{event.text}</span>
								) : (
									<span className="agent-activity-text">{event.text}</span>
								)}
								{time}
							</div>
						)
					}
					default:
						return null
				}
			})}
			{workingAgents.length > 0 && (
				<div className="waiting-indicator">
					<span className="spinner-inline" />
					<span className="waiting-label">
						{workingAgents.map((a) => a.name).join(", ")}{" "}
						{workingAgents.length === 1 ? "is" : "are"} working
					</span>
				</div>
			)}
			<div ref={bottomRef} />
		</div>
	)
}

function RoomInput({
	roomId,
	participants,
	disabled,
	sending,
	setSending,
}: {
	roomId: string
	participants: Array<{ sessionId: string; name: string }>
	disabled: boolean
	sending: boolean
	setSending: (v: boolean) => void
}) {
	const [text, setText] = useState("")
	const [target, setTarget] = useState<string>("broadcast")
	const [sendError, setSendError] = useState<string | null>(null)
	const textareaRef = useRef<HTMLTextAreaElement>(null)

	const handleSubmit = useCallback(async () => {
		const trimmed = text.trim()
		if (!trimmed || !roomId) return
		setSending(true)
		setSendError(null)
		try {
			const participant = getOrCreateParticipant()
			const to = target === "broadcast" ? undefined : target
			await sendRoomMessage(roomId, participant.displayName, trimmed, to)
			setText("")
			if (textareaRef.current) {
				textareaRef.current.style.height = "auto"
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Failed to send message"
			setSendError(msg)
		} finally {
			setSending(false)
		}
	}, [text, roomId, target, setSending])

	const handleInput = useCallback(() => {
		const ta = textareaRef.current
		if (ta) {
			ta.style.height = "auto"
			ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
		}
	}, [])

	return (
		<div className="prompt-bar room-prompt-bar">
			{sendError && (
				<div className="room-send-error">
					{sendError}
					<button type="button" onClick={() => setSendError(null)}>
						&times;
					</button>
				</div>
			)}
			<select
				className="room-target-select"
				value={target}
				onChange={(e) => setTarget(e.target.value)}
				disabled={disabled}
			>
				<option value="broadcast">broadcast</option>
				{participants.map((p) => (
					<option key={p.sessionId} value={p.name}>
						@{p.name}
					</option>
				))}
			</select>
			<textarea
				ref={textareaRef}
				value={text}
				onChange={(e) => {
					setText(e.target.value)
					handleInput()
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault()
						handleSubmit()
					}
				}}
				placeholder={disabled ? "Closed" : "Send a message..."}
				disabled={disabled}
				rows={1}
			/>
			<button
				type="button"
				className="primary"
				onClick={handleSubmit}
				disabled={disabled || !text.trim() || sending}
			>
				{sending ? "..." : "Send"}
			</button>
		</div>
	)
}

/** Built-in roles that map to role skill files with specific tool permissions. */
const AGENT_ROLES = [
	{ value: "coder", label: "Coder", description: "Writes code, creates PRs" },
	{ value: "reviewer", label: "Reviewer", description: "Reviews PRs (read-only)" },
	{ value: "ui-designer", label: "UI Designer", description: "Audits and improves UI" },
	{ value: "custom", label: "Custom", description: "No preset role — define with a skill" },
] as const

function AddAgentModal({
	roomId,
	onClose,
	onAdded,
}: {
	roomId: string
	onClose: () => void
	onAdded: () => void
}) {
	const [name, setName] = useState("")
	const [role, setRole] = useState("coder")
	const [initialPrompt, setInitialPrompt] = useState("")
	const [customSkill, setCustomSkill] = useState("")
	const [adding, setAdding] = useState(false)
	const [addError, setAddError] = useState<string | null>(null)

	const isCustom = role === "custom"

	const handleAdd = useCallback(async () => {
		setAdding(true)
		setAddError(null)
		try {
			const result = await addAgentToRoom(roomId, {
				name: name.trim() || undefined,
				role: isCustom ? undefined : role.trim() || undefined,
				initialPrompt: initialPrompt.trim() || undefined,
				customSkill: isCustom && customSkill.trim() ? customSkill.trim() : undefined,
			})
			if (result.sessionToken) {
				setSessionToken(result.sessionId, result.sessionToken)
			}
			addSession({
				id: result.sessionId,
				projectName: result.participantName,
				sandboxProjectDir: "",
				description: role.trim() || `Agent ${roomId.slice(0, 8)}`,
				createdAt: new Date().toISOString(),
				lastActiveAt: new Date().toISOString(),
				status: "running",
			})
			onAdded()
		} catch (err) {
			setAddError(err instanceof Error ? err.message : "Failed to add agent")
		} finally {
			setAdding(false)
		}
	}, [roomId, name, role, isCustom, initialPrompt, customSkill, onAdded])

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal-card" onClick={(e) => e.stopPropagation()}>
				<div className="modal-title">Add Agent</div>
				<div className="modal-body">
					<label className="room-form-label">
						Name
						<input
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="e.g. coder-2, ui-auditor"
						/>
					</label>
					<label className="room-form-label">
						Role
						<select value={role} onChange={(e) => setRole(e.target.value)}>
							{AGENT_ROLES.map((r) => (
								<option key={r.value} value={r.value}>
									{r.label} — {r.description}
								</option>
							))}
						</select>
					</label>
					{isCustom && (
						<label className="room-form-label">
							Skill
							<textarea
								value={customSkill}
								onChange={(e) => setCustomSkill(e.target.value)}
								placeholder="Paste skill instructions (written to .claude/skills/role/SKILL.md)"
								rows={6}
							/>
						</label>
					)}
					<label className="room-form-label">
						Initial Prompt
						<textarea
							value={initialPrompt}
							onChange={(e) => setInitialPrompt(e.target.value)}
							placeholder="Optional message to send after agent joins"
							rows={3}
						/>
					</label>
					{addError && <p className="room-form-error">{addError}</p>}
				</div>
				<div className="modal-actions">
					<button type="button" className="modal-btn" onClick={onClose}>
						Cancel
					</button>
					<button type="button" className="modal-btn primary" onClick={handleAdd} disabled={adding}>
						{adding ? "Adding..." : "Add Agent"}
					</button>
					{adding && (
						<div className="waiting-indicator">
							<span className="spinner-inline" />
							<span className="waiting-label">Initializing agent...</span>
						</div>
					)}
				</div>
			</div>
		</div>
	)
}

