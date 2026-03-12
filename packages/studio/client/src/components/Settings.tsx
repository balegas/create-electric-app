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

	const placeholder =
		keyType === "api-key"
			? authSource === "api-key"
				? "Enter new key to override..."
				: "sk-ant-..."
			: isManualOauth()
				? "Enter new token to override..."
				: "Paste OAuth token..."

	return createPortal(
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal-card" onClick={(e) => e.stopPropagation()}>
				<div className="modal-title">Settings</div>

				{/* Claude Authentication (dev mode only) */}
				{devMode && (
				<div className="settings-field" style={{ marginTop: 12 }}>
					<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
						<label htmlFor={keyInputId} style={{ margin: 0 }}>
							Claude Authentication
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
					{authSource === "keychain" && (
						<div style={{ fontSize: 11, color: "var(--text-subtle)", marginBottom: 8 }}>
							Credentials detected from macOS Keychain. No manual key needed.
						</div>
					)}
					{!authSource && (
						<div style={{ fontSize: 11, color: "var(--text-subtle)", marginBottom: 8 }}>
							If you have Claude Code installed on macOS, credentials are automatically read from
							the Keychain. Otherwise, enter a key below.
						</div>
					)}
					<div className="settings-input-row">
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
						<input
							id={keyInputId}
							type="password"
							value={keyValue}
							onChange={(e) => setKeyValue(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder={placeholder}
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
				)}

				{/* GitHub PAT (dev mode only) */}
				{devMode && (<>
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
				</>)}

				{/* Agent mode */}
				<div className="settings-divider" />
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
