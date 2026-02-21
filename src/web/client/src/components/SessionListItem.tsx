import { useState } from "react"
import { createPortal } from "react-dom"
import type { SessionInfo } from "../lib/api"

interface SessionListItemProps {
	session: SessionInfo
	active: boolean
	collapsed: boolean
	onClick: () => void
	onDelete: () => void
}

// Pastel palette — 12 distinct colors that work on dark backgrounds
const AVATAR_COLORS = [
	{ bg: "#4a3f6b", fg: "#d0bcff" }, // purple
	{ bg: "#2d4a4a", fg: "#75fbfd" }, // cyan
	{ bg: "#3b4a2d", fg: "#a8e6a1" }, // green
	{ bg: "#4a3a2d", fg: "#ffb87a" }, // orange
	{ bg: "#4a2d3b", fg: "#f8a4c8" }, // pink
	{ bg: "#2d3b4a", fg: "#9ecbff" }, // blue
	{ bg: "#4a4a2d", fg: "#e6e6a1" }, // yellow
	{ bg: "#3b2d4a", fg: "#c4a4f8" }, // lavender
	{ bg: "#2d4a3b", fg: "#75e6b8" }, // mint
	{ bg: "#4a2d2d", fg: "#f8a4a4" }, // coral
	{ bg: "#2d3a4a", fg: "#a4d4f8" }, // sky
	{ bg: "#4a3b2d", fg: "#e6c4a1" }, // sand
]

function hashString(str: string): number {
	let hash = 0
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
	}
	return Math.abs(hash)
}

function getAvatarColor(sessionId: string) {
	return AVATAR_COLORS[hashString(sessionId) % AVATAR_COLORS.length]
}

function formatTimeAgo(dateStr: string): string {
	const diff = Date.now() - new Date(dateStr).getTime()
	const minutes = Math.floor(diff / 60000)
	if (minutes < 1) return "just now"
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.floor(hours / 24)
	return `${days}d ago`
}

function DeleteModal({
	projectName,
	onConfirm,
	onCancel,
}: {
	projectName: string
	onConfirm: () => void
	onCancel: () => void
}) {
	return createPortal(
		<div className="modal-overlay" onClick={onCancel}>
			<div className="modal-card" onClick={(e) => e.stopPropagation()}>
				<div className="modal-title">Delete {projectName}?</div>
				<div className="modal-body">
					All containers, database state, and generated code will be permanently lost.
				</div>
				<div className="modal-actions">
					<button type="button" className="modal-btn" onClick={onCancel}>
						Cancel
					</button>
					<button type="button" className="modal-btn modal-btn-danger" onClick={onConfirm}>
						Delete
					</button>
				</div>
			</div>
		</div>,
		document.body,
	)
}

export function SessionListItem({
	session,
	active,
	collapsed,
	onClick,
	onDelete,
}: SessionListItemProps) {
	const [showDeleteModal, setShowDeleteModal] = useState(false)

	const statusRingClass = `session-avatar-${session.status}`
	const avatarClass = `session-avatar ${statusRingClass}`
	const color = getAvatarColor(session.id)
	const avatarStyle = { background: color.bg, color: color.fg }
	const initials = session.projectName
		.split(/[-_ ]+/)
		.slice(0, 2)
		.map((w) => w.charAt(0).toUpperCase())
		.join("")

	if (collapsed) {
		return (
			<div
				className={`session-item ${active ? "active" : ""}`}
				onClick={onClick}
				title={session.projectName}
			>
				<span className={avatarClass} style={avatarStyle}>
					{initials}
				</span>
			</div>
		)
	}

	return (
		<>
			<div className={`session-item ${active ? "active" : ""}`} onClick={onClick}>
				<span className={avatarClass} style={avatarStyle}>
					{initials}
				</span>
				<div className="session-item-details">
					<div className="session-item-name">{session.projectName}</div>
					<div className="session-item-meta">
						<span>{formatTimeAgo(session.lastActiveAt)}</span>
					</div>
				</div>
				<button
					type="button"
					className="session-item-delete"
					onClick={(e) => {
						e.stopPropagation()
						setShowDeleteModal(true)
					}}
					title="Delete session"
				>
					&times;
				</button>
			</div>
			{showDeleteModal && (
				<DeleteModal
					projectName={session.projectName}
					onConfirm={() => {
						setShowDeleteModal(false)
						onDelete()
					}}
					onCancel={() => setShowDeleteModal(false)}
				/>
			)}
		</>
	)
}
