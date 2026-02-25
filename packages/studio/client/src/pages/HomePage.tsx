import { useCallback, useState } from "react"
import { useNavigate, useOutletContext } from "react-router-dom"
import { PromptInput } from "../components/PromptInput"
import { RepoPickerModal } from "../components/RepoPickerModal"
import { Settings } from "../components/Settings"
import { useAppContext } from "../layouts/AppShell"
import { createSharedSession, resumeFromGithub } from "../lib/api"

interface OutletCtx {
	openMobileDrawer: () => void
}

export function HomePage() {
	const {
		authSource,
		hasGhToken,
		showSettings,
		setShowSettings,
		refreshSettings,
		refreshSessions,
		handleNewProject,
		loading,
	} = useAppContext()

	const navigate = useNavigate()
	const { openMobileDrawer } = useOutletContext<OutletCtx>()
	const [showRepoPicker, setShowRepoPicker] = useState(false)
	const [resuming, setResuming] = useState(false)
	const [creatingShared, setCreatingShared] = useState(false)

	const handleCreateSharedSession = useCallback(async () => {
		const name = prompt("Shared session name:")
		if (!name?.trim()) return
		setCreatingShared(true)
		try {
			const { code } = await createSharedSession(name.trim())
			navigate(`/shared/${code}`)
		} catch (err) {
			console.error("Failed to create shared session:", err)
		} finally {
			setCreatingShared(false)
		}
	}, [navigate])

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
			{showSettings && (
				<Settings
					authSource={authSource}
					hasGhToken={hasGhToken ?? false}
					onKeySaved={refreshSettings}
					onClose={() => setShowSettings(false)}
				/>
			)}

			<div className="mobile-home-topbar">
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
				<img src="/img/brand/logo.svg" alt="Electric" className="mobile-topbar-logo" />
			</div>

			<div className="hero">
				<img src="/img/brand/logo.svg" alt="Electric" className="hero-logo" />
				<p className="hero-subtitle">Build Reactive apps on Sync</p>
				<div className="hero-prompt">
					<PromptInput
						onSubmit={handleNewProject}
						placeholder={
							!authSource
								? "Set an API key in Settings to get started..."
								: "Describe the application you want to build..."
						}
						disabled={loading || !authSource}
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
				<button
					type="button"
					className="hero-resume-btn"
					onClick={handleCreateSharedSession}
					disabled={creatingShared}
				>
					{creatingShared ? "Creating..." : "Create Shared Session"}
				</button>
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
