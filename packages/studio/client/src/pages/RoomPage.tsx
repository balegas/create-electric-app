import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom"
import { getAvatarColor } from "../components/SessionListItem"
import { type RoomEvent, useRoomEvents } from "../hooks/useRoomEvents"
import { useAppContext } from "../layouts/AppShell"
import { addAgentRoom, getAgentRooms } from "../lib/agent-room-store"
import {
	addAgentToRoom,
	addSessionToRoom,
	closeAgentRoom,
	createAppRoom,
	getAgentRoomState,
	type RoomState,
	sendRoomMessage,
} from "../lib/api"
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
	const { refreshSessions, refreshAgentRooms } = useAppContext()
	const [roomState, setRoomState] = useState<RoomState | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [showAddAgent, setShowAddAgent] = useState(false)
	const [sending, setSending] = useState(false)
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
				addAgentRoom({
					id: result.roomId,
					code: result.code,
					name: result.name,
					createdAt: new Date().toISOString(),
					sessions: {
						coder: findSession("coder"),
						reviewer: findSession("reviewer"),
						uiDesigner: findSession("ui-designer"),
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
						// Sync participant status to localStorage so sidebar reflects it
						for (const p of state.participants) {
							updateSession(p.sessionId, {
								status: p.running ? "running" : "complete",
								needsInput: p.needsInput,
							})
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

	const handleClose = useCallback(async () => {
		if (!roomId) return
		try {
			await closeAgentRoom(roomId)
			setRoomState((prev) => (prev ? { ...prev, state: "closed" } : prev))
		} catch (err) {
			console.error("Failed to close room:", err)
		}
	}, [roomId])

	if (error) {
		return (
			<div className="room-error">
				<h2>Cannot load room</h2>
				<p>{error}</p>
				<button type="button" className="btn" onClick={() => navigate("/")}>
					Go Home
				</button>
			</div>
		)
	}

	const effectiveState = isClosed ? "closed" : roomState?.state
	const participants = roomState?.participants ?? []

	return (
		<>
			<RoomHeader
				roomId={roomId}
				roomName={roomEntry?.name}
				roomCode={roomEntry?.code}
				state={effectiveState}
				participants={participants}
				onClose={handleClose}
				onAddAgent={() => setShowAddAgent(true)}
				openMobileDrawer={openMobileDrawer}
			/>

			<div className="session-content">
				<div className="room-messages">
					<RoomEventList
						events={events}
						participants={participants}
						provisioning={!!roomEntry?.sessions && participants.length < 3}
					/>
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
	onClose,
	onAddAgent,
	openMobileDrawer,
}: {
	roomId?: string
	roomName?: string
	roomCode?: string
	state?: string
	participants: Array<{ sessionId: string; name: string; role?: string; running?: boolean }>
	onClose: () => void
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

			<span className="session-header-name">{roomName || `Room ${roomId?.slice(0, 8)}`}</span>

			{state === "active" && (
				<span className="session-header-status" style={{ color: "var(--green)" }}>
					Active
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

			<span className="session-header-actions-group">
				<button
					type="button"
					className="session-header-action"
					onClick={onAddAgent}
					disabled={state === "closed"}
				>
					+ Agent
				</button>
				{state === "active" && (
					<button type="button" className="session-header-action" onClick={onClose}>
						Close Room
					</button>
				)}
			</span>
		</div>
	)
}

function ParticipantLink({
	name,
	participants,
}: {
	name: string
	participants: Array<{ sessionId: string; name: string; role?: string; running?: boolean }>
}) {
	const navigate = useNavigate()
	const participant = participants.find((p) => p.name === name)
	if (!participant) return <span className="room-message-from">{name}</span>
	return (
		<button
			type="button"
			className="room-message-from room-message-from-link"
			onClick={() => navigate(`/session/${participant.sessionId}`)}
			title={`Go to ${name}'s session`}
		>
			{name}
		</button>
	)
}

function escapeRegExp(str: string) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function RoomMessageBody({
	body,
	participants,
}: {
	body: string
	participants: Array<{ sessionId: string; name: string; role?: string; running?: boolean }>
}) {
	const navigate = useNavigate()
	const nameMap = new Map(participants.map((p) => [p.name, p.sessionId]))

	if (nameMap.size === 0) return <>{body}</>

	const namePattern = [...nameMap.keys()].map(escapeRegExp).join("|")
	const regex = new RegExp(`(${namePattern})`, "g")
	const parts = body.split(regex)

	return (
		<>
			{parts.map((part, i) => {
				const sessionId = nameMap.get(part)
				if (sessionId) {
					return (
						<button
							key={`${part}-${i}`}
							type="button"
							className="room-inline-link"
							onClick={() => navigate(`/session/${sessionId}`)}
							title={`Go to ${part}'s session`}
						>
							{part}
						</button>
					)
				}
				return <span key={`text-${i}`}>{part}</span>
			})}
		</>
	)
}

function RoomEventList({
	events,
	participants,
	provisioning,
}: {
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
					<div className="room-working-indicator">
						<span className="room-working-dots">
							<span />
							<span />
							<span />
						</span>
						<span className="room-working-text">Setting up agents</span>
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
				switch (event.type) {
					case "agent_message":
						return (
							<div key={key} className="room-event room-message">
								<ParticipantLink name={event.from} participants={participants} />
								{event.to && <span className="room-message-to">&rarr; {event.to}</span>}
								<span className="room-message-body">
									<RoomMessageBody body={event.body} participants={participants} />
								</span>
								<span className="room-message-time">{new Date(event.ts).toLocaleTimeString()}</span>
							</div>
						)
					case "participant_joined":
						return (
							<div key={key} className="room-event room-system-event">
								<span>{event.participant?.displayName ?? "Unknown"} joined the room</span>
								<span className="room-message-time">{new Date(event.ts).toLocaleTimeString()}</span>
							</div>
						)
					case "participant_left":
						return (
							<div key={key} className="room-event room-system-event">
								<span>Participant left</span>
							</div>
						)
					case "room_closed":
						return (
							<div key={key} className="room-event room-system-event room-closed-event">
								<span>Room closed by {event.closedBy}</span>
								{event.summary && <span> — {event.summary}</span>}
							</div>
						)
					default:
						return null
				}
			})}
			{workingAgents.length > 0 && (
				<div className="room-working-indicator">
					<span className="room-working-dots">
						<span />
						<span />
						<span />
					</span>
					<span className="room-working-text">
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
				<option value="broadcast">@room (broadcast)</option>
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
				placeholder={disabled ? "Room closed" : "Send a message..."}
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
const BUILT_IN_ROLES = [
	{ value: "coder", label: "Coder", description: "Writes code, creates PRs" },
	{ value: "reviewer", label: "Reviewer", description: "Reviews PRs (read-only)" },
	{ value: "ui-designer", label: "UI Designer", description: "Audits and improves UI" },
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
	const { sessions } = useAppContext()
	const [mode, setMode] = useState<"new" | "existing">("new")
	const [role, setRole] = useState("")
	const [gated, setGated] = useState(false)
	const [initialPrompt, setInitialPrompt] = useState("")
	const [selectedSessionId, setSelectedSessionId] = useState("")
	const [adding, setAdding] = useState(false)
	const [addError, setAddError] = useState<string | null>(null)

	// Show sessions that are still usable (running or complete — sandbox is still alive)
	const availableSessions = sessions.filter(
		(s) => s.status === "running" || s.status === "complete",
	)

	const handleAdd = useCallback(async () => {
		setAdding(true)
		setAddError(null)
		try {
			if (mode === "existing") {
				if (!selectedSessionId) return
				const session = availableSessions.find((s) => s.id === selectedSessionId)
				const displayName = session?.projectName ?? selectedSessionId.slice(0, 8)
				await addSessionToRoom(roomId, {
					sessionId: selectedSessionId,
					name: displayName,
					initialPrompt: initialPrompt.trim() || undefined,
				})
			} else {
				const result = await addAgentToRoom(roomId, {
					role: role.trim() || undefined,
					gated,
					initialPrompt: initialPrompt.trim() || undefined,
				})
				if (result.sessionToken) {
					setSessionToken(result.sessionId, result.sessionToken)
				}
				addSession({
					id: result.sessionId,
					projectName: result.participantName,
					sandboxProjectDir: "",
					description: role.trim() || `Agent in room ${roomId.slice(0, 8)}`,
					createdAt: new Date().toISOString(),
					lastActiveAt: new Date().toISOString(),
					status: "running",
				})
			}
			onAdded()
		} catch (err) {
			setAddError(err instanceof Error ? err.message : "Failed to add agent")
		} finally {
			setAdding(false)
		}
	}, [roomId, mode, role, gated, initialPrompt, selectedSessionId, availableSessions, onAdded])

	const canSubmit = mode === "existing" ? !!selectedSessionId : true

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal-card" onClick={(e) => e.stopPropagation()}>
				<div className="modal-title">Add Agent to Room</div>
				<div className="modal-body">
					<div className="room-form-toggle">
						<button
							type="button"
							className={`room-form-toggle-btn ${mode === "new" ? "active" : ""}`}
							onClick={() => setMode("new")}
						>
							New Agent
						</button>
						<button
							type="button"
							className={`room-form-toggle-btn ${mode === "existing" ? "active" : ""}`}
							onClick={() => setMode("existing")}
						>
							Existing Session
						</button>
					</div>
					{mode === "existing" ? (
						<label className="room-form-label">
							Session *
							<select
								value={selectedSessionId}
								onChange={(e) => setSelectedSessionId(e.target.value)}
							>
								<option value="">Select a session...</option>
								{availableSessions.map((s) => (
									<option key={s.id} value={s.id}>
										{s.projectName} ({s.id.slice(0, 8)})
									</option>
								))}
							</select>
						</label>
					) : (
						<>
							<label className="room-form-label">
								Role
								<select value={role} onChange={(e) => setRole(e.target.value)}>
									<option value="">No role (generic participant)</option>
									{BUILT_IN_ROLES.map((r) => (
										<option key={r.value} value={r.value}>
											{r.label} — {r.description}
										</option>
									))}
								</select>
							</label>
							<label className="room-form-label">
								Initial Prompt
								<textarea
									value={initialPrompt}
									onChange={(e) => setInitialPrompt(e.target.value)}
									placeholder="Optional message to send after agent joins"
									rows={3}
								/>
							</label>
							<label className="room-form-checkbox">
								<input
									type="checkbox"
									checked={gated}
									onChange={(e) => setGated(e.target.checked)}
								/>
								Gated (require approval for outbound messages)
							</label>
						</>
					)}
					{addError && <p className="room-form-error">{addError}</p>}
				</div>
				<div className="modal-actions">
					<button type="button" className="modal-btn" onClick={onClose}>
						Cancel
					</button>
					<button
						type="button"
						className="modal-btn primary"
						onClick={handleAdd}
						disabled={!canSubmit || adding}
					>
						{adding ? "Adding..." : mode === "existing" ? "Join Room" : "Add Agent"}
					</button>
				</div>
			</div>
		</div>
	)
}
