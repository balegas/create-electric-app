import { useCallback, useId, useState } from "react"
import { createPortal } from "react-dom"
import { useEscapeKey } from "../hooks/useKeyboardShortcut"
import type { AuthSource } from "../layouts/AppShell"
import {
	clearApiKey,
	clearGhToken,
	setApiKey as saveApiKey,
	setGhToken as saveGhToken,
} from "../lib/credentials"

interface SettingsProps {
	authSource: AuthSource
	hasGhToken: boolean
	onKeySaved: () => void
	onClose: () => void
	onCopyLog?: () => void
	devMode?: boolean
}

export function Settings({
	authSource,
	hasGhToken,
	onKeySaved,
	onClose,
	onCopyLog,
	devMode,
}: SettingsProps) {
	const keyInputId = useId()
	const ghInputId = useId()
	const [keyValue, setKeyValue] = useState("")
	const [ghPat, setGhPat] = useState("")
	const [copied, setCopied] = useState(false)

	const hasManualCredential = authSource === "api-key"

	const handleSaveKey = useCallback(() => {
		if (!keyValue.trim()) return
		saveApiKey(keyValue.trim())
		setKeyValue("")
		onKeySaved()
	}, [keyValue, onKeySaved])

	const handleClearKey = useCallback(() => {
		clearApiKey()
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
				handleSaveKey()
			}
		},
		[handleSaveKey],
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

	// Status text for Claude auth
	const authStatusText = (() => {
		if (authSource === "keychain") return "From Keychain"
		if (authSource === "api-key") return "Key set"
		return "No credentials"
	})()

	// Help text for Claude auth
	const authHelpText = (() => {
		if (authSource === "keychain") {
			return "Credentials loaded from macOS Keychain. You can override with an Anthropic key below."
		}
		if (!authSource) {
			return "If you have Claude Code installed on macOS, credentials are automatically read from the Keychain. Otherwise, enter a key below."
		}
		return null
	})()

	return createPortal(
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal-card" onClick={(e) => e.stopPropagation()}>
				<div className="modal-title">Settings</div>

				{/* Anthropic Key */}
				<div className="settings-field" style={{ marginTop: 12 }}>
					<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
						<label htmlFor={keyInputId} style={{ margin: 0 }}>
							Anthropic Key
						</label>
						<span className={`settings-status ${authSource ? "active" : "missing"}`}>
							{authStatusText}
						</span>
					</div>
					{authHelpText && (
						<div style={{ fontSize: 11, color: "var(--text-subtle)", marginBottom: 8 }}>
							{authHelpText}
						</div>
					)}
					<div className="settings-input-row">
						<input
							id={keyInputId}
							type="password"
							value={keyValue}
							onChange={(e) => setKeyValue(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder={authSource === "api-key" ? "Enter new key to override..." : "sk-ant-..."}
						/>
						{keyValue.trim() ? (
							<button type="button" onClick={handleSaveKey} className="primary">
								Save
							</button>
						) : (
							hasManualCredential && (
								<button type="button" onClick={handleClearKey} className="btn btn-danger">
									Remove
								</button>
							)
						)}
					</div>
				</div>

				{/* GitHub PAT — always visible */}
				<div className="settings-divider" />
				<div className="settings-section-label">GitHub</div>
				<div className="settings-field">
					<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
						<label htmlFor={ghInputId} style={{ margin: 0 }}>
							Personal Access Token
						</label>
						{hasGhToken && <span className="settings-status active">Connected</span>}
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
						Apps are created in{" "}
						<a
							href="https://github.com/electric-apps"
							target="_blank"
							rel="noopener noreferrer"
							style={{ color: "var(--brand-1)" }}
						>
							github.com/electric-apps
						</a>
						. Add a{" "}
						<a
							href="https://github.com/settings/tokens/new?scopes=repo,read:user"
							target="_blank"
							rel="noopener noreferrer"
							style={{ color: "var(--brand-1)" }}
						>
							PAT
						</a>{" "}
						to create repos under your own account.
					</div>
				</div>

				{/* Debug (dev mode only) */}
				{devMode && onCopyLog && (
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
