import { useCallback, useState } from "react"
import { checkpointSession, createPr, publishSession, type SessionGitState } from "../lib/api"

interface GitControlsProps {
	sessionId: string
	gitState: SessionGitState | undefined
	onUpdate: () => void
}

export function GitControls({ sessionId, gitState, onUpdate }: GitControlsProps) {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const handleCheckpoint = useCallback(async () => {
		setBusy(true)
		setError(null)
		try {
			// POST triggers the gate prompt inline in the console.
			// The server blocks until the user submits the form.
			const result = await checkpointSession(sessionId)
			if (!result.success && result.error) {
				setError(result.error)
			}
			onUpdate()
		} catch (e) {
			setError(e instanceof Error ? e.message : "Checkpoint failed")
		} finally {
			setBusy(false)
		}
	}, [sessionId, onUpdate])

	const handlePublish = useCallback(async () => {
		setBusy(true)
		setError(null)
		try {
			// POST triggers the gate prompt inline in the console.
			// The server blocks until the user submits the form.
			const result = await publishSession(sessionId)
			if (!result.success && result.error) {
				setError(result.error)
			}
			onUpdate()
		} catch (e) {
			setError(e instanceof Error ? e.message : "Publish failed")
		} finally {
			setBusy(false)
		}
	}, [sessionId, onUpdate])

	const handleCreatePr = useCallback(async () => {
		setBusy(true)
		setError(null)
		try {
			const result = await createPr(sessionId)
			if (result.prUrl) {
				window.open(result.prUrl, "_blank")
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : "PR creation failed")
		} finally {
			setBusy(false)
		}
	}, [sessionId])

	const isPublished = !!gitState?.remoteUrl

	return (
		<>
			{/* Branch badge when connected */}
			{isPublished && gitState?.branch && (
				<span className="git-status-badge" title={gitState.repoName ?? undefined}>
					{gitState.branch}
				</span>
			)}

			{/* Checkpoint button */}
			<button
				type="button"
				className="session-header-action"
				onClick={handleCheckpoint}
				disabled={busy}
				title="Create a git checkpoint"
			>
				{busy ? "..." : "Checkpoint"}
			</button>

			{/* Publish or PR button */}
			{isPublished ? (
				<button
					type="button"
					className="session-header-action primary"
					onClick={handleCreatePr}
					disabled={busy}
					title="Create a pull request"
				>
					Open PR
				</button>
			) : (
				<button
					type="button"
					className="session-header-action primary"
					onClick={handlePublish}
					disabled={busy}
					title="Publish to GitHub"
				>
					Publish
				</button>
			)}

			{error && (
				<span style={{ color: "var(--red)", fontSize: 11, maxWidth: 200 }} title={error}>
					{error.slice(0, 40)}
				</span>
			)}
		</>
	)
}
