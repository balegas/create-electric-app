import type { Participant } from "@electric-agent/protocol"
import { useCallback, useState } from "react"

interface SharedSessionHeaderProps {
	name: string
	code: string
	participants: Participant[]
	revoked: boolean
	isLive: boolean
	onLeave: () => void
	onLinkSession: () => void
}

export function SharedSessionHeader({
	name,
	code,
	participants,
	revoked,
	isLive,
	onLeave,
	onLinkSession,
}: SharedSessionHeaderProps) {
	const [copied, setCopied] = useState(false)

	const handleCopyCode = useCallback(() => {
		navigator.clipboard.writeText(code)
		setCopied(true)
		setTimeout(() => setCopied(false), 2000)
	}, [code])

	return (
		<div className="shared-session-header">
			<span className="shared-session-header-name">{name}</span>

			{isLive && (
				<span className="session-header-status" style={{ color: "var(--green)" }}>
					Live
				</span>
			)}

			<span className="shared-session-header-participants">
				{participants.map((p) => (
					<span key={p.id} className="shared-session-participant" title={p.displayName}>
						{p.displayName.slice(0, 2).toUpperCase()}
					</span>
				))}
			</span>

			<button type="button" className="invite-code-btn" onClick={handleCopyCode}>
				{copied ? "Copied!" : code}
				{revoked && " (revoked)"}
			</button>

			<button type="button" className="session-header-action primary" onClick={onLinkSession}>
				Link Session
			</button>

			<button type="button" className="session-header-action" onClick={onLeave}>
				Leave
			</button>
		</div>
	)
}
