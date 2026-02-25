import { useCallback, useEffect, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { Console } from "../components/Console"
import { SharedSessionHeader } from "../components/SharedSessionHeader"
import { Skeleton } from "../components/Skeleton"
import { useSession } from "../hooks/useSession"
import { useSharedSession } from "../hooks/useSharedSession"
import { useAppContext } from "../layouts/AppShell"
import {
	joinAsParticipant,
	joinSharedSession,
	leaveSharedSession,
	linkSession,
	unlinkSession,
} from "../lib/api"
import { addJoinedSharedSession, removeJoinedSharedSession } from "../lib/shared-session-store"

export function SharedSessionPage() {
	const { code } = useParams<{ code: string }>()
	const navigate = useNavigate()
	const { sessions, refreshSessions, refreshJoinedSharedSessions } = useAppContext()
	const [sharedSessionId, setSharedSessionId] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [joining, setJoining] = useState(true)
	const [showLinkModal, setShowLinkModal] = useState(false)
	const [expandedPanels, setExpandedPanels] = useState<Set<string>>(new Set())

	// Join the shared session on mount
	useEffect(() => {
		if (!code) return
		let cancelled = false

		async function join() {
			try {
				const result = await joinSharedSession(code as string)
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
	}, [code])

	const sharedSession = useSharedSession(sharedSessionId)

	// Save to localStorage once we have the session name
	useEffect(() => {
		if (code && sharedSession.name && sharedSessionId) {
			addJoinedSharedSession({ id: sharedSessionId, code, name: sharedSession.name })
			refreshJoinedSharedSessions()
		}
	}, [code, sharedSession.name, sharedSessionId, refreshJoinedSharedSessions])

	// Auto-expand first panel when sessions are linked
	useEffect(() => {
		if (sharedSession.sessionIds.length > 0 && expandedPanels.size === 0) {
			setExpandedPanels(new Set([sharedSession.sessionIds[0]]))
		}
	}, [sharedSession.sessionIds, expandedPanels.size])

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
			try {
				await linkSession(sharedSessionId, sessionId)
				setShowLinkModal(false)
				// Auto-expand the newly linked panel
				setExpandedPanels((prev) => new Set([...prev, sessionId]))
			} catch (err) {
				console.error("Failed to link session:", err)
			}
		},
		[sharedSessionId],
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

	// Refresh sessions list for linking
	useEffect(() => {
		refreshSessions()
	}, [refreshSessions])

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
								sessionId={sid}
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
	sessionId,
	expanded,
	onToggle,
	onUnlink,
}: {
	sessionId: string
	expanded: boolean
	onToggle: () => void
	onUnlink: (sessionId: string) => void
}) {
	const { entries, isLive, isComplete, markGateResolved } = useSession(sessionId)

	return (
		<div className={`shared-session-panel ${expanded ? "expanded" : "collapsed"}`}>
			<div className="shared-session-panel-header" onClick={onToggle}>
				<ChevronIcon />
				<span className="shared-session-panel-id">{sessionId.slice(0, 8)}</span>
				{isLive && (
					<span className="session-header-status" style={{ color: "var(--green)", fontSize: 11 }}>
						Live
					</span>
				)}
				{isComplete && (
					<span
						className="session-header-status"
						style={{ color: "var(--text-subtle)", fontSize: 11 }}
					>
						Complete
					</span>
				)}
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
			{expanded && (
				<div className="shared-session-panel-body">
					<Console
						sessionId={sessionId}
						entries={entries}
						isLive={isLive}
						isComplete={isComplete}
						onGateResolved={markGateResolved}
					/>
				</div>
			)}
		</div>
	)
}
