import { useCallback, useId, useState } from "react"
import { createPortal } from "react-dom"
import { setApiKey as saveApiKey, setGhToken as saveGhToken } from "../lib/credentials"

interface SettingsProps {
	hasApiKey: boolean
	hasGhToken: boolean
	onKeySaved: () => void
	onClose: () => void
	onCopyLog?: () => void
}

export function Settings({ hasApiKey, hasGhToken, onKeySaved, onClose, onCopyLog }: SettingsProps) {
	const apiInputId = useId()
	const ghInputId = useId()
	const [apiKey, setApiKey] = useState("")
	const [ghPat, setGhPat] = useState("")
	const [copied, setCopied] = useState(false)

	const handleSaveApiKey = useCallback(() => {
		if (!apiKey.trim()) return
		saveApiKey(apiKey.trim())
		setApiKey("")
		onKeySaved()
	}, [apiKey, onKeySaved])

	const handleSaveGhPat = useCallback(() => {
		if (!ghPat.trim()) return
		saveGhToken(ghPat.trim())
		setGhPat("")
		onKeySaved()
	}, [ghPat, onKeySaved])

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault()
				handleSaveApiKey()
			}
		},
		[handleSaveApiKey],
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
						<span className={`settings-status ${hasApiKey ? "active" : "missing"}`}>
							{hasApiKey ? "API key set" : "No API key"}
						</span>
					</div>
					<div className="settings-input-row">
						<input
							id={apiInputId}
							type="password"
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder={hasApiKey ? "Enter new key to override..." : "sk-ant-..."}
						/>
						<button
							type="button"
							onClick={handleSaveApiKey}
							disabled={!apiKey.trim()}
							className="primary"
						>
							Save
						</button>
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
						<button
							type="button"
							onClick={handleSaveGhPat}
							disabled={!ghPat.trim()}
							className="primary"
						>
							Save
						</button>
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
