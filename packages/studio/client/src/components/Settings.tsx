import { useCallback, useId, useState } from "react"
import { createPortal } from "react-dom"
import { useEscapeKey } from "../hooks/useKeyboardShortcut"
import type { AuthSource } from "../layouts/AppShell"
import {
	clearApiKey,
	clearGhToken,
	clearOauthToken,
	isManualOauth,
	setApiKey as saveApiKey,
	setGhToken as saveGhToken,
	setManualOauthToken as saveOauthToken,
} from "../lib/credentials"

type KeyType = "api-key" | "oauth"

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
	const [keyType, setKeyType] = useState<KeyType>(
		isManualOauth() || authSource === "oauth" ? "oauth" : "api-key",
	)
	const [keyValue, setKeyValue] = useState("")
	const [ghPat, setGhPat] = useState("")
	const [copied, setCopied] = useState(false)

	const hasManualCredential = keyType === "api-key" ? authSource === "api-key" : isManualOauth()

	const handleSaveKey = useCallback(() => {
		if (!keyValue.trim()) return
		if (keyType === "api-key") {
			saveApiKey(keyValue.trim())
		} else {
			saveOauthToken(keyValue.trim())
		}
		setKeyValue("")
		onKeySaved()
	}, [keyValue, keyType, onKeySaved])

	const handleClearKey = useCallback(() => {
		if (keyType === "api-key") {
			clearApiKey()
		} else {
			clearOauthToken()
		}
		onKeySaved()
	}, [keyType, onKeySaved])

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

	// In prod mode, only show API Key option (no OAuth manual entry)
	const showOauthOption = devMode

	const placeholder =
		keyType === "api-key"
			? authSource === "api-key"
				? "Enter new key to override..."
				: "sk-ant-..."
			: isManualOauth()
				? "Enter new token to override..."
				: "Paste OAuth token..."

	// Status text for Claude auth
	const authStatusText = (() => {
		if (!devMode) {
			// In prod: show what's active (env or keychain), or prompt for key
			if (authSource === "keychain") return "Using keychain"
			if (authSource === "api-key") return "User key set"
			return "No credentials"
		}
		if (authSource === "keychain") return "Using Claude keychain"
		if (authSource === "oauth") return "OAuth token set"
		if (authSource === "api-key") return "API key set"
		return "No credentials"
	})()

	// Help text for Claude auth
	const authHelpText = (() => {
		if (!devMode) {
			if (authSource === "keychain") {
				return "Credentials loaded from macOS Keychain. You can override with an API key below."
			}
			if (!authSource) {
				return "No server-side credentials detected. Provide a Claude API key to use the app."
			}
			if (authSource === "api-key") {
				return "Using your API key. Server-side keychain or env credentials will take priority if available."
			}
			return null
		}
		if (authSource === "keychain") {
			return "Credentials detected from macOS Keychain. No manual key needed."
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

				{/* Claude Authentication — always visible */}
				<div className="settings-field" style={{ marginTop: 12 }}>
					<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
						<label htmlFor={keyInputId} style={{ margin: 0 }}>
							Claude Authentication
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
						{showOauthOption ? (
							<select
								value={keyType}
								onChange={(e) => {
									setKeyType(e.target.value as KeyType)
									setKeyValue("")
								}}
								className="settings-key-type-select"
							>
								<option value="api-key">API Key</option>
								<option value="oauth">OAuth Token</option>
							</select>
						) : null}
						<input
							id={keyInputId}
							type="password"
							value={keyValue}
							onChange={(e) => setKeyValue(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder={
								!showOauthOption
									? authSource === "api-key"
										? "Enter new key to override..."
										: "sk-ant-..."
									: placeholder
							}
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
