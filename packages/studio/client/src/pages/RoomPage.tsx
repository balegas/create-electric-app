import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate, useOutletContext, useParams } from "react-router-dom"
import { type RoomEvent, useRoomEvents } from "../hooks/useRoomEvents"
import {
	addAgentToRoom,
	closeAgentRoom,
	getAgentRoomState,
	iterateRoomSession,
	type RoomState,
	sendRoomMessage,
} from "../lib/api"
import { getOrCreateParticipant } from "../lib/participant"
import { setSessionToken } from "../lib/session-store"

interface OutletCtx {
	openMobileDrawer: () => void
}

export function RoomPage() {
	const { id: roomId } = useParams<{ id: string }>()
	const navigate = useNavigate()
	const { openMobileDrawer } = useOutletContext<OutletCtx>()
	const [roomState, setRoomState] = useState<RoomState | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [showAddAgent, setShowAddAgent] = useState(false)
	const [sending, setSending] = useState(false)

	const { events, isClosed } = useRoomEvents(roomId ?? null)

	// Fetch room state on mount + periodically
	useEffect(() => {
		if (!roomId) return
		let cancelled = false
		const fetchState = () => {
			getAgentRoomState(roomId)
				.then((state) => {
					if (!cancelled) setRoomState(state)
				})
				.catch((err) => {
					if (!cancelled) setError(err.message)
				})
		}
		fetchState()
		const interval = setInterval(fetchState, 5000)
		return () => {
			cancelled = true
			clearInterval(interval)
		}
	}, [roomId])

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
			<div className="shared-session-error">
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
				state={effectiveState}
				participants={participants}
				roundCount={roomState?.roundCount ?? 0}
				onClose={handleClose}
				onAddAgent={() => setShowAddAgent(true)}
				openMobileDrawer={openMobileDrawer}
			/>

			<div className="session-content">
				<div className="room-messages">
					<RoomEventList events={events} participants={participants} roomId={roomId ?? ""} />
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
	state,
	participants,
	roundCount,
	onClose,
	onAddAgent,
	openMobileDrawer,
}: {
	roomId?: string
	state?: string
	participants: Array<{ sessionId: string; name: string; role?: string }>
	roundCount: number
	onClose: () => void
	onAddAgent: () => void
	openMobileDrawer: () => void
}) {
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

			<span className="session-header-name">Room {roomId?.slice(0, 8)}</span>

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

			<span className="session-header-cost" title={`${roundCount} rounds`}>
				{participants.length} agents &middot; {roundCount} rounds
			</span>

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

function RoomEventList({
	events,
	participants,
	roomId,
}: {
	events: RoomEvent[]
	participants: Array<{ sessionId: string; name: string; role?: string }>
	roomId: string
}) {
	const bottomRef = useRef<HTMLDivElement>(null)
	const [dmTarget, setDmTarget] = useState<{ sessionId: string; name: string } | null>(null)
	const [dmText, setDmText] = useState("")
	const [dmSending, setDmSending] = useState(false)

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" })
	}, [events.length])

	const handleSendDm = useCallback(async () => {
		if (!dmTarget || !dmText.trim()) return
		setDmSending(true)
		try {
			await iterateRoomSession(roomId, dmTarget.sessionId, dmText.trim())
			setDmText("")
			setDmTarget(null)
		} catch (err) {
			console.error("Failed to send DM:", err)
		} finally {
			setDmSending(false)
		}
	}, [roomId, dmTarget, dmText])

	if (events.length === 0) {
		return (
			<div className="room-empty">
				<p>No messages yet. Add agents to start the conversation.</p>
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
								<div className="room-message-header">
									<span className="room-message-from">{event.from}</span>
									{event.to && <span className="room-message-to">&rarr; {event.to}</span>}
									<span className="room-message-time">
										{new Date(event.ts).toLocaleTimeString()}
									</span>
								</div>
								<div className="room-message-body">{event.body}</div>
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
			<div ref={bottomRef} />

			{participants.length > 0 && (
				<div className="room-dm-section">
					<div className="room-dm-label">Direct message to session:</div>
					<div className="room-dm-targets">
						{participants.map((p) => (
							<button
								key={p.sessionId}
								type="button"
								className={`room-dm-target ${dmTarget?.sessionId === p.sessionId ? "active" : ""}`}
								onClick={() =>
									setDmTarget(
										dmTarget?.sessionId === p.sessionId
											? null
											: { sessionId: p.sessionId, name: p.name },
									)
								}
							>
								{p.name}
								{p.role && <span className="room-dm-role"> ({p.role})</span>}
							</button>
						))}
					</div>
					{dmTarget && (
						<div className="room-dm-input">
							<textarea
								value={dmText}
								onChange={(e) => setDmText(e.target.value)}
								placeholder={`Message to ${dmTarget.name}...`}
								rows={2}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault()
										handleSendDm()
									}
								}}
							/>
							<button
								type="button"
								className="primary"
								onClick={handleSendDm}
								disabled={!dmText.trim() || dmSending}
							>
								{dmSending ? "Sending..." : "Send DM"}
							</button>
						</div>
					)}
				</div>
			)}
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
	const textareaRef = useRef<HTMLTextAreaElement>(null)

	const handleSubmit = useCallback(async () => {
		const trimmed = text.trim()
		if (!trimmed || !roomId) return
		setSending(true)
		try {
			const participant = getOrCreateParticipant()
			const to = target === "broadcast" ? undefined : target
			await sendRoomMessage(roomId, participant.displayName, trimmed, to)
			setText("")
			if (textareaRef.current) {
				textareaRef.current.style.height = "auto"
			}
		} catch (err) {
			console.error("Failed to send message:", err)
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
	const [role, setRole] = useState("")
	const [gated, setGated] = useState(false)
	const [initialPrompt, setInitialPrompt] = useState("")
	const [adding, setAdding] = useState(false)
	const [addError, setAddError] = useState<string | null>(null)

	const handleAdd = useCallback(async () => {
		if (!name.trim()) return
		setAdding(true)
		setAddError(null)
		try {
			const result = await addAgentToRoom(roomId, {
				name: name.trim(),
				role: role.trim() || undefined,
				gated,
				initialPrompt: initialPrompt.trim() || undefined,
			})
			// Store the session token so the session is accessible
			if (result.sessionToken) {
				setSessionToken(result.sessionId, result.sessionToken)
			}
			onAdded()
		} catch (err) {
			setAddError(err instanceof Error ? err.message : "Failed to add agent")
		} finally {
			setAdding(false)
		}
	}, [roomId, name, role, gated, initialPrompt, onAdded])

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal-card" onClick={(e) => e.stopPropagation()}>
				<div className="modal-title">Add Agent to Room</div>
				<div className="modal-body">
					<label className="room-form-label">
						Name *
						<input
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="e.g. reviewer, coder, architect"
						/>
					</label>
					<label className="room-form-label">
						Role
						<input
							type="text"
							value={role}
							onChange={(e) => setRole(e.target.value)}
							placeholder="e.g. code reviewer, test writer"
						/>
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
						<input type="checkbox" checked={gated} onChange={(e) => setGated(e.target.checked)} />
						Gated (require approval for outbound messages)
					</label>
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
						disabled={!name.trim() || adding}
					>
						{adding ? "Adding..." : "Add Agent"}
					</button>
				</div>
			</div>
		</div>
	)
}
