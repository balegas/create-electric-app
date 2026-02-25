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
export function SharedSessionPage() {
	const { code } = useParams<{ code: string }>()
	const navigate = useNavigate()
	const { sessions, refreshSessions } = useAppContext()
	const [sharedSessionId, setSharedSessionId] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [joining, setJoining] = useState(true)
	const [showLinkPicker, setShowLinkPicker] = useState(false)

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

	const handleLeave = useCallback(async () => {
		if (!sharedSessionId) return
		try {
			await leaveSharedSession(sharedSessionId)
		} catch {
			// Best effort
		}
		navigate("/")
	}, [sharedSessionId, navigate])

	const handleLinkSession = useCallback(
		async (sessionId: string) => {
			if (!sharedSessionId) return
			try {
				await linkSession(sharedSessionId, sessionId)
				setShowLinkPicker(false)
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
			} catch (err) {
				console.error("Failed to unlink session:", err)
			}
		},
		[sharedSessionId],
	)

	// Refresh sessions list for linking
	useEffect(() => {
		refreshSessions()
	}, [refreshSessions])

	if (error) {
		return (
			<div className="shared-session-error">
				<h2>Cannot join shared session</h2>
				<p>{error}</p>
				<button type="button" onClick={() => navigate("/")}>
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
						onClick={() => setShowLinkPicker((v) => !v)}
					>
						+ Link Session
					</button>
				</div>

				{showLinkPicker && (
					<div className="shared-session-link-picker">
						{availableToLink.length === 0 ? (
							<p className="shared-session-link-picker-empty">No sessions available to link.</p>
						) : (
							availableToLink.map((s) => (
								<button
									key={s.id}
									type="button"
									className="shared-session-link-picker-item"
									onClick={() => handleLinkSession(s.id)}
								>
									{s.projectName} — {s.description.slice(0, 60)}
								</button>
							))
						)}
					</div>
				)}

				{sharedSession.sessionIds.length === 0 ? (
					<div className="shared-session-empty">
						<p>No sessions linked yet. Click "Link Session" to add one.</p>
					</div>
				) : (
					<div className="shared-session-grid">
						{sharedSession.sessionIds.map((sid) => (
							<LinkedSessionPanel key={sid} sessionId={sid} onUnlink={handleUnlinkSession} />
						))}
					</div>
				)}
			</div>
		</>
	)
}

function LinkedSessionPanel({
	sessionId,
	onUnlink,
}: {
	sessionId: string
	onUnlink: (sessionId: string) => void
}) {
	const { entries, isLive, isComplete, markGateResolved } = useSession(sessionId)

	return (
		<div className="shared-session-panel">
			<div className="shared-session-panel-header">
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
					onClick={() => onUnlink(sessionId)}
					title="Unlink session"
				>
					Unlink
				</button>
			</div>
			<Console
				sessionId={sessionId}
				entries={entries}
				isLive={isLive}
				isComplete={isComplete}
				onGateResolved={markGateResolved}
			/>
		</div>
	)
}
