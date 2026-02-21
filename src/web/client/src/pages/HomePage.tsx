import { useCallback, useState } from "react"
import { useNavigate } from "react-router-dom"
import { PromptInput } from "../components/PromptInput"
import { RepoPickerModal } from "../components/RepoPickerModal"
import { Settings } from "../components/Settings"
import { useAppContext } from "../layouts/AppShell"
import { resumeFromGithub } from "../lib/api"

export function HomePage() {
	const {
		hasApiKey,
		hasGhToken,
		showSettings,
		setShowSettings,
		refreshSettings,
		refreshSessions,
		handleNewProject,
		loading,
	} = useAppContext()

	const navigate = useNavigate()
	const [showRepoPicker, setShowRepoPicker] = useState(false)
	const [resuming, setResuming] = useState(false)

	const handleResumeFromGithub = useCallback(
		async (repoUrl: string, branch: string) => {
			setShowRepoPicker(false)
			setResuming(true)
			try {
				const { sessionId } = await resumeFromGithub(repoUrl, branch)
				await refreshSessions()
				navigate(`/session/${sessionId}`)
			} catch (err) {
				console.error("Failed to resume from GitHub:", err)
			} finally {
				setResuming(false)
			}
		},
		[navigate, refreshSessions],
	)

	return (
		<>
			{showSettings && hasApiKey !== null && (
				<Settings
					hasApiKey={hasApiKey}
					hasGhToken={hasGhToken ?? false}
					onKeySaved={refreshSettings}
					onClose={() => setShowSettings(false)}
				/>
			)}

			<div className="hero">
				<img src="/img/brand/logo.svg" alt="Electric" className="hero-logo" />
				<p className="hero-subtitle">Build Reactive apps on Sync</p>
				<div className="hero-prompt">
					<PromptInput
						onSubmit={handleNewProject}
						placeholder={
							hasApiKey === false
								? "Set an API key in Settings to get started..."
								: "Describe the application you want to build..."
						}
						disabled={loading || hasApiKey === false}
					/>
				</div>
				{hasGhToken && (
					<button
						type="button"
						className="hero-resume-btn"
						onClick={() => setShowRepoPicker(true)}
						disabled={resuming}
					>
						{resuming ? "Cloning..." : "Resume from GitHub"}
					</button>
				)}
			</div>

			{showRepoPicker && (
				<RepoPickerModal
					onSelect={handleResumeFromGithub}
					onClose={() => setShowRepoPicker(false)}
				/>
			)}
		</>
	)
}
