import { useCallback, useId, useState } from "react"
import { createPortal } from "react-dom"
import { updateSettings } from "../lib/api"

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
	const [saving, setSaving] = useState(false)
	const [savingGh, setSavingGh] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [ghError, setGhError] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)

	const handleSaveApiKey = useCallback(async () => {
		if (!apiKey.trim()) return
		setSaving(true)
		setError(null)
		try {
			await updateSettings({ anthropicApiKey: apiKey.trim() })
			setApiKey("")
			onKeySaved()
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save")
		} finally {
			setSaving(false)
		}
	}, [apiKey, onKeySaved])

	const handleSaveGhPat = useCallback(async () => {
		if (!ghPat.trim()) return
		setSavingGh(true)
		setGhError(null)
		try {
			await updateSettings({ githubPat: ghPat.trim() })
			setGhPat("")
			onKeySaved()
		} catch (err) {
			setGhError(err instanceof Error ? err.message : "Failed to validate token")
		} finally {
			setSavingGh(false)
		}
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
							disabled={saving}
						/>
						<button
							type="button"
							onClick={handleSaveApiKey}
							disabled={saving || !apiKey.trim()}
							className="primary"
						>
							{saving ? "Saving..." : "Save"}
						</button>
					</div>
					{error && <div className="settings-error">{error}</div>}
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
							disabled={savingGh}
						/>
						<button
							type="button"
							onClick={handleSaveGhPat}
							disabled={savingGh || !ghPat.trim()}
							className="primary"
						>
							{savingGh ? "Validating..." : "Save"}
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
					{ghError && <div className="settings-error">{ghError}</div>}
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
