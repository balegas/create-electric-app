import { useCallback, useId, useState } from "react"
import { createPortal } from "react-dom"
import { useEscapeKey } from "../hooks/useKeyboardShortcut"
import type { AuthSource } from "../layouts/AppShell"
import {
	type AgentMode,
	clearApiKey,
	clearGhToken,
	clearOauthToken,
	getAgentMode,
	isManualOauth,
	setAgentMode as saveAgentMode,
	setApiKey as saveApiKey,
	setGhToken as saveGhToken,
	setManualOauthToken as saveOauthToken,
} from "../lib/credentials"

interface SettingsProps {
	authSource: AuthSource
	hasGhToken: boolean
	onKeySaved: () => void
	onClose: () => void
	onCopyLog?: () => void
}

export function Settings({
	authSource,
	hasGhToken,
	onKeySaved,
	onClose,
	onCopyLog,
}: SettingsProps) {
	const apiInputId = useId()
	const oauthInputId = useId()
	const ghInputId = useId()
	const [apiKey, setApiKey] = useState("")
	const [oauthToken, setOauthToken] = useState("")
	const [ghPat, setGhPat] = useState("")
	const [copied, setCopied] = useState(false)
	const [agentMode, setAgentMode] = useState<AgentMode>(getAgentMode)

	const handleAgentMode = useCallback((mode: AgentMode) => {
		setAgentMode(mode)
		saveAgentMode(mode)
	}, [])

	const handleSaveApiKey = useCallback(() => {
		if (!apiKey.trim()) return
		saveApiKey(apiKey.trim())
		setApiKey("")
		onKeySaved()
	}, [apiKey, onKeySaved])

	const handleClearApiKey = useCallback(() => {
		clearApiKey()
		onKeySaved()
	}, [onKeySaved])

	const handleSaveOauthToken = useCallback(() => {
		if (!oauthToken.trim()) return
		saveOauthToken(oauthToken.trim())
		setOauthToken("")
		onKeySaved()
	}, [oauthToken, onKeySaved])

	const handleClearOauthToken = useCallback(() => {
		clearOauthToken()
		onKeySaved()
	}, [onKeySaved])

	const handleSaveGhPat = useCallback(() => {
		if (!ghPat.trim()) return
		saveGhToken(ghPat.trim())
		setGhPat("")
		onKeySaved()
	}, [ghPat, onKeySaved])

	const handleClearGhToken = useCallback(() => {
		clearGhToken()
		onKeySaved()
	}, [onKeySaved])

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault()
				handleSaveApiKey()
			}
		},
		[handleSaveApiKey],
	)

	const handleOauthKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault()
				handleSaveOauthToken()
			}
		},
		[handleSaveOauthToken],
	)

	const handleGhKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault()
				handleSaveGhPat()
			}
		},
		[handleSaveGhPat],
	)

	const handleCopy = useCallback(() => {
		onCopyLog?.()
		setCopied(true)
		setTimeout(() => setCopied(false), 2000)
	}, [onCopyLog])

	useEscapeKey(onClose)

	return createPortal(
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal-card" onClick={(e) => e.stopPropagation()}>
				<div className="modal-title">Settings</div>

				{/* Anthropic API Key */}
				<div className="settings-field" style={{ marginTop: 12 }}>
					<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
						<label htmlFor={apiInputId} style={{ margin: 0 }}>
							Anthropic API Key
						</label>
						<span className={`settings-status ${authSource ? "active" : "missing"}`}>
							{authSource === "keychain"
								? "Using Claude keychain"
								: authSource === "oauth"
									? "OAuth token set"
									: authSource === "api-key"
										? "API key set"
										: "No credentials"}
						</span>
					</div>
					<div className="settings-input-row">
						<input
							id={apiInputId}
							type="password"
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder={authSource === "api-key" ? "Enter new key to override..." : "sk-ant-..."}
						/>
						{apiKey.trim() ? (
							<button type="button" onClick={handleSaveApiKey} className="primary">
								Save
							</button>
						) : (
							authSource === "api-key" && (
								<button type="button" onClick={handleClearApiKey} className="btn btn-danger">
									Remove
								</button>
							)
						)}
					</div>
				</div>

				{/* OAuth Token Override */}
				<div className="settings-field">
					<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
						<label htmlFor={oauthInputId} style={{ margin: 0 }}>
							OAuth Token
						</label>
						{isManualOauth() && <span className="settings-status active">Manual override</span>}
					</div>
					<div className="settings-input-row">
						<input
							id={oauthInputId}
							type="password"
							value={oauthToken}
							onChange={(e) => setOauthToken(e.target.value)}
							onKeyDown={handleOauthKeyDown}
							placeholder={
								isManualOauth() ? "Enter new token to override..." : "Paste OAuth token..."
							}
						/>
						{oauthToken.trim() ? (
							<button type="button" onClick={handleSaveOauthToken} className="primary">
								Save
							</button>
						) : (
							isManualOauth() && (
								<button type="button" onClick={handleClearOauthToken} className="btn btn-danger">
									Remove
								</button>
							)
						)}
					</div>
					<div style={{ fontSize: 11, color: "var(--text-subtle)", marginTop: 4 }}>
						Override the OAuth token used for Claude authentication. Takes priority over keychain.
					</div>
				</div>

				{/* GitHub PAT */}
				<div className="settings-divider" />
				<div className="settings-section-label">GitHub</div>
				<div className="settings-field">
					<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
						<label htmlFor={ghInputId} style={{ margin: 0 }}>
							Personal Access Token
						</label>
						<span className={`settings-status ${hasGhToken ? "active" : "missing"}`}>
							{hasGhToken ? "Connected" : "Not connected"}
						</span>
					</div>
					<div className="settings-input-row">
						<input
							id={ghInputId}
							type="password"
							value={ghPat}
							onChange={(e) => setGhPat(e.target.value)}
							onKeyDown={handleGhKeyDown}
							placeholder={hasGhToken ? "Enter new token to override..." : "ghp_..."}
						/>
						{ghPat.trim() ? (
							<button type="button" onClick={handleSaveGhPat} className="primary">
								Save
							</button>
						) : (
							hasGhToken && (
								<button type="button" onClick={handleClearGhToken} className="btn btn-danger">
									Remove
								</button>
							)
						)}
					</div>
					<div style={{ fontSize: 11, color: "var(--text-subtle)", marginTop: 4 }}>
						Required scopes: <code>repo</code>, <code>read:user</code>. Create one at{" "}
						<a
							href="https://github.com/settings/tokens/new?scopes=repo,read:user"
							target="_blank"
							rel="noopener noreferrer"
							style={{ color: "var(--brand-1)" }}
						>
							github.com/settings/tokens
						</a>
					</div>
				</div>

				{/* Agent mode */}
				<div className="settings-divider" />
				<div className="settings-section-label">Agent</div>
				<div className="settings-field">
					<label style={{ margin: 0, marginBottom: 4 }}>Agent Mode</label>
					<div style={{ fontSize: 11, color: "var(--text-subtle)", marginBottom: 8 }}>
						Applies to new sessions only
					</div>
					<div className="font-size-options">
						{(["claude-code", "electric-agent"] as const).map((mode) => (
							<button
								key={mode}
								type="button"
								className={`font-size-option${agentMode === mode ? " active" : ""}`}
								onClick={() => handleAgentMode(mode)}
							>
								{mode === "claude-code" ? "Claude Code" : "Electric Agent"}
							</button>
						))}
					</div>
				</div>

				{onCopyLog && (
					<>
						<div className="settings-divider" />
						<div className="settings-section-label">Debug</div>
						<button type="button" className="btn" onClick={handleCopy}>
							{copied ? "Copied!" : "Copy session log"}
						</button>
					</>
				)}

				<div className="modal-actions" style={{ marginTop: 16 }}>
					<button type="button" className="modal-btn" onClick={onClose}>
						Close
					</button>
				</div>
			</div>
		</div>,
		document.body,
	)
}
