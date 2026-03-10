import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { Console } from "../components/Console"
import { SharedSessionHeader } from "../components/SharedSessionHeader"
import { Skeleton } from "../components/Skeleton"
import { useSession } from "../hooks/useSession"
import { useSharedSession } from "../hooks/useSharedSession"
import { useAppContext } from "../layouts/AppShell"
import {
	getLinkedSessionToken,
	joinAsParticipant,
	joinSharedSession,
	leaveSharedSession,
	linkSession,
	unlinkSession,
} from "../lib/api"
import { getSessionToken, setSessionToken } from "../lib/session-store"
import { addJoinedSharedSession, removeJoinedSharedSession } from "../lib/shared-session-store"

export function SharedSessionPage() {
	const { id, code } = useParams<{ id: string; code: string }>()
	const navigate = useNavigate()
	const { sessions, refreshJoinedSharedSessions } = useAppContext()
	const [sharedSessionId, setSharedSessionId] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [joining, setJoining] = useState(true)
	const [showLinkModal, setShowLinkModal] = useState(false)
	const [expandedPanels, setExpandedPanels] = useState<Set<string>>(new Set())

	// Join the shared session on mount
	useEffect(() => {
		if (!id || !code) return
		let cancelled = false

		async function join() {
			try {
				const result = await joinSharedSession(id as string, code as string)
				if (cancelled) return
				if (result.revoked) {
					setError("This invite code has been revoked.")
					setJoining(false)
					return
				}
				setSharedSessionId(result.id)
				await joinAsParticipant(result.id)
				setJoining(false)
			} catch (err) {
				if (cancelled) return
				setError(err instanceof Error ? err.message : "Failed to join shared session")
				setJoining(false)
			}
		}

		join()
		return () => {
			cancelled = true
		}
	}, [id, code])

	const sharedSession = useSharedSession(sharedSessionId)

	// Save to localStorage once we have the session name
	useEffect(() => {
		if (code && sharedSession.name && sharedSessionId) {
			addJoinedSharedSession({ id: sharedSessionId, code, name: sharedSession.name })
			refreshJoinedSharedSessions()
		}
	}, [code, sharedSession.name, sharedSessionId, refreshJoinedSharedSessions])

	// Auto-expand first panel on initial link (only once)
	const hasAutoExpanded = useRef(false)
	useEffect(() => {
		if (sharedSession.sessionIds.length > 0 && !hasAutoExpanded.current) {
			hasAutoExpanded.current = true
			setExpandedPanels(new Set([sharedSession.sessionIds[0]]))
		}
	}, [sharedSession.sessionIds])

	const handleLeave = useCallback(async () => {
		if (!sharedSessionId) return
		try {
			await leaveSharedSession(sharedSessionId)
		} catch {
			// Best effort
		}
		if (code) {
			removeJoinedSharedSession(code)
			refreshJoinedSharedSessions()
		}
		navigate("/")
	}, [sharedSessionId, code, navigate, refreshJoinedSharedSessions])

	const handleLinkSession = useCallback(
		async (sessionId: string) => {
			if (!sharedSessionId) return
			// Find session metadata from localStorage
			const session = sessions.find((s) => s.id === sessionId)
			try {
				await linkSession(
					sharedSessionId,
					sessionId,
					session?.projectName || "",
					session?.description || "",
				)
				setShowLinkModal(false)
				// Auto-expand the newly linked panel
				setExpandedPanels((prev) => new Set([...prev, sessionId]))
			} catch (err) {
				console.error("Failed to link session:", err)
			}
		},
		[sharedSessionId, sessions],
	)

	const handleUnlinkSession = useCallback(
		async (sessionId: string) => {
			if (!sharedSessionId) return
			try {
				await unlinkSession(sharedSessionId, sessionId)
				setExpandedPanels((prev) => {
					const next = new Set(prev)
					next.delete(sessionId)
					return next
				})
			} catch (err) {
				console.error("Failed to unlink session:", err)
			}
		},
		[sharedSessionId],
	)

	const togglePanel = useCallback((sessionId: string) => {
		setExpandedPanels((prev) => {
			const next = new Set(prev)
			if (next.has(sessionId)) {
				next.delete(sessionId)
			} else {
				next.add(sessionId)
			}
			return next
		})
	}, [])

	if (error) {
		return (
			<div className="shared-session-error">
				<h2>Cannot join shared session</h2>
				<p>{error}</p>
				<button type="button" className="btn" onClick={() => navigate("/")}>
					Go Home
				</button>
			</div>
		)
	}

	if (joining || !sharedSessionId) {
		return (
			<div style={{ padding: 16 }}>
				<Skeleton variant="block" />
				<Skeleton variant="line" width="60%" />
			</div>
		)
	}

	// Filter sessions not already linked
	const availableToLink = sessions.filter((s) => !sharedSession.sessionIds.includes(s.id))

	return (
		<>
			<SharedSessionHeader
				name={sharedSession.name}
				id={sharedSessionId}
				code={sharedSession.code}
				participants={sharedSession.participants}
				revoked={sharedSession.revoked}
				isLive={sharedSession.isLive}
				onLeave={handleLeave}
				onLinkSession={() => setShowLinkModal(true)}
			/>

			<div className="shared-session-content">
				<div className="shared-session-toolbar">
					<span className="shared-session-toolbar-label">
						{sharedSession.sessionIds.length} session
						{sharedSession.sessionIds.length !== 1 ? "s" : ""} linked
					</span>
					<button
						type="button"
						className="shared-session-link-btn"
						onClick={() => setShowLinkModal(true)}
					>
						+ Link Session
					</button>
				</div>

				{sharedSession.sessionIds.length === 0 ? (
					<div className="shared-session-empty">
						<p>No sessions linked yet. Click "Link Session" to add one.</p>
					</div>
				) : (
					<div className="shared-session-panels">
						{sharedSession.sessionIds.map((sid) => (
							<LinkedSessionPanel
								key={sid}
								roomId={sharedSessionId}
								sessionId={sid}
								sessionName={sharedSession.sessionNames.get(sid)}
								expanded={expandedPanels.has(sid)}
								onToggle={() => togglePanel(sid)}
								onUnlink={handleUnlinkSession}
							/>
						))}
					</div>
				)}
			</div>

			{showLinkModal && (
				<div className="modal-overlay" onClick={() => setShowLinkModal(false)}>
					<div className="modal-card" onClick={(e) => e.stopPropagation()}>
						<div className="modal-title">Link Session</div>
						<div className="modal-body">Select a session to link to this shared room.</div>
						{availableToLink.length === 0 ? (
							<p style={{ color: "var(--text-subtle)", fontSize: 13 }}>
								No sessions available to link.
							</p>
						) : (
							<div className="link-session-list">
								{availableToLink.map((s) => (
									<button
										key={s.id}
										type="button"
										className="link-session-item"
										onClick={() => handleLinkSession(s.id)}
									>
										{s.projectName || s.description.slice(0, 60) || s.id.slice(0, 8)}
									</button>
								))}
							</div>
						)}
						<div className="modal-actions">
							<button type="button" className="modal-btn" onClick={() => setShowLinkModal(false)}>
								Cancel
							</button>
						</div>
					</div>
				</div>
			)}
		</>
	)
}

function ChevronIcon() {
	return (
		<svg
			className="shared-session-panel-chevron"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-label="Toggle panel"
		>
			<title>Toggle panel</title>
			<polyline points="4 6 8 10 12 6" />
		</svg>
	)
}

function LinkedSessionPanel({
	roomId,
	sessionId,
	sessionName,
	expanded,
	onToggle,
	onUnlink,
}: {
	roomId: string
	sessionId: string
	sessionName?: string
	expanded: boolean
	onToggle: () => void
	onUnlink: (sessionId: string) => void
}) {
	const [tokenReady, setTokenReady] = useState(false)
	const [sessionStatus, setSessionStatus] = useState<{
		isLive: boolean
		isComplete: boolean
	}>({ isLive: false, isComplete: false })

	useEffect(() => {
		if (getSessionToken(sessionId)) {
			setTokenReady(true)
			return
		}
		let cancelled = false
		getLinkedSessionToken(roomId, sessionId)
			.then(({ sessionToken }) => {
				if (cancelled) return
				setSessionToken(sessionId, sessionToken)
				setTokenReady(true)
			})
			.catch((err) => {
				if (!cancelled) console.error("Failed to fetch linked session token:", err)
			})
		return () => {
			cancelled = true
		}
	}, [roomId, sessionId])

	return (
		<div className={`shared-session-panel ${expanded ? "expanded" : "collapsed"}`}>
			<div className="shared-session-panel-header" onClick={onToggle}>
				<ChevronIcon />
				<span className="shared-session-panel-id">{sessionName || sessionId.slice(0, 8)}</span>
				{!tokenReady ? (
					<span
						className="session-header-status"
						style={{ color: "var(--text-subtle)", fontSize: 11 }}
					>
						Connecting...
					</span>
				) : sessionStatus.isComplete ? (
					<span
						className="session-header-status"
						style={{ color: "var(--text-subtle)", fontSize: 11 }}
					>
						Offline
					</span>
				) : sessionStatus.isLive ? (
					<span className="session-header-status" style={{ color: "var(--green)", fontSize: 11 }}>
						Live
					</span>
				) : null}
				<button
					type="button"
					className="shared-session-unlink-btn"
					onClick={(e) => {
						e.stopPropagation()
						onUnlink(sessionId)
					}}
					title="Unlink session"
				>
					Unlink
				</button>
			</div>
			<div className="shared-session-panel-body">
				{tokenReady ? (
					<LinkedSessionContent sessionId={sessionId} onStatusChange={setSessionStatus} />
				) : (
					<Skeleton variant="block" />
				)}
			</div>
		</div>
	)
}

function LinkedSessionContent({
	sessionId,
	onStatusChange,
}: {
	sessionId: string
	onStatusChange: (status: { isLive: boolean; isComplete: boolean }) => void
}) {
	const { entries, isLive, isComplete, markGateResolved } = useSession(sessionId)

	useEffect(() => {
		onStatusChange({ isLive, isComplete })
	}, [isLive, isComplete, onStatusChange])

	return (
		<Console
			sessionId={sessionId}
			entries={entries}
			isLive={isLive}
			isComplete={isComplete}
			onGateResolved={markGateResolved}
		/>
	)
}
