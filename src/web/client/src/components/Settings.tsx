import { useCallback, useEffect, useId, useState } from "react"
import { createPortal } from "react-dom"
import {
	type CoderModelConfig,
	getModelSettings,
	type ModelInfo,
	type PlannerModelConfig,
	updateModelSettings,
	updateSettings,
} from "../lib/api"

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

	// Model settings state
	const [models, setModels] = useState<ModelInfo[]>([])
	const [plannerConfig, setPlannerConfig] = useState<PlannerModelConfig | null>(null)
	const [coderConfig, setCoderConfig] = useState<CoderModelConfig | null>(null)
	const [savingModels, setSavingModels] = useState(false)
	const [modelError, setModelError] = useState<string | null>(null)
	const [modelSaved, setModelSaved] = useState(false)

	// Load model settings on mount
	useEffect(() => {
		getModelSettings()
			.then(({ models: m, settings }) => {
				setModels(m)
				setPlannerConfig({ ...settings.planner })
				setCoderConfig({ ...settings.coder })
			})
			.catch(() => {
				// Settings endpoint not available — hide section
			})
	}, [])

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

	const handleSaveModelSettings = useCallback(async () => {
		if (!plannerConfig || !coderConfig) return
		setSavingModels(true)
		setModelError(null)
		setModelSaved(false)
		try {
			const result = await updateModelSettings({
				planner: plannerConfig,
				coder: coderConfig,
			})
			setPlannerConfig({ ...result.settings.planner })
			setCoderConfig({ ...result.settings.coder })
			setModelSaved(true)
			setTimeout(() => setModelSaved(false), 2000)
		} catch (err) {
			setModelError(err instanceof Error ? err.message : "Failed to save model settings")
		} finally {
			setSavingModels(false)
		}
	}, [plannerConfig, coderConfig])

	const selectStyle: React.CSSProperties = {
		flex: 1,
		padding: "6px 8px",
		background: "var(--bg-surface)",
		color: "var(--text)",
		border: "1px solid var(--border)",
		borderRadius: 4,
		fontSize: 13,
		fontFamily: "inherit",
	}

	const numberInputStyle: React.CSSProperties = {
		width: 90,
		padding: "6px 8px",
		background: "var(--bg-surface)",
		color: "var(--text)",
		border: "1px solid var(--border)",
		borderRadius: 4,
		fontSize: 13,
		fontFamily: "inherit",
		textAlign: "right",
	}

	const fieldRowStyle: React.CSSProperties = {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12,
		marginBottom: 8,
	}

	const fieldLabelStyle: React.CSSProperties = {
		fontSize: 12,
		color: "var(--text-muted)",
		minWidth: 110,
		flexShrink: 0,
	}

	return createPortal(
		<div className="modal-overlay" onClick={onClose}>
			<div
				className="modal-card"
				onClick={(e) => e.stopPropagation()}
				style={{ maxHeight: "85vh", overflowY: "auto" }}
			>
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

				{/* Agent Model Settings */}
				{plannerConfig && coderConfig && models.length > 0 && (
					<>
						<div className="settings-divider" />
						<div className="settings-section-label">Agent Models</div>
						<div style={{ fontSize: 11, color: "var(--text-subtle)", marginBottom: 12 }}>
							Configure the model and parameters for each agent. Changes apply to new sessions.
						</div>

						{/* Planner */}
						<div style={{ marginBottom: 16 }}>
							<div
								style={{
									fontSize: 12,
									fontWeight: 600,
									color: "var(--brand-1)",
									marginBottom: 8,
									textTransform: "uppercase",
									letterSpacing: "0.05em",
								}}
							>
								Planner
							</div>
							<div style={fieldRowStyle}>
								<span style={fieldLabelStyle}>Model</span>
								<select
									style={selectStyle}
									value={plannerConfig.model}
									onChange={(e) =>
										setPlannerConfig((prev) => (prev ? { ...prev, model: e.target.value } : prev))
									}
								>
									{models.map((m) => (
										<option key={m.id} value={m.id}>
											{m.label}
										</option>
									))}
								</select>
							</div>
							<div style={fieldRowStyle}>
								<span style={fieldLabelStyle}>Thinking tokens</span>
								<input
									type="number"
									style={numberInputStyle}
									value={plannerConfig.maxThinkingTokens}
									min={1024}
									max={32768}
									step={1024}
									onChange={(e) =>
										setPlannerConfig((prev) =>
											prev ? { ...prev, maxThinkingTokens: Number(e.target.value) } : prev,
										)
									}
								/>
							</div>
							<div style={fieldRowStyle}>
								<span style={fieldLabelStyle}>Max turns</span>
								<input
									type="number"
									style={numberInputStyle}
									value={plannerConfig.maxTurns}
									min={1}
									max={100}
									onChange={(e) =>
										setPlannerConfig((prev) =>
											prev ? { ...prev, maxTurns: Number(e.target.value) } : prev,
										)
									}
								/>
							</div>
						</div>

						{/* Coder */}
						<div style={{ marginBottom: 12 }}>
							<div
								style={{
									fontSize: 12,
									fontWeight: 600,
									color: "var(--brand-1)",
									marginBottom: 8,
									textTransform: "uppercase",
									letterSpacing: "0.05em",
								}}
							>
								Coder
							</div>
							<div style={fieldRowStyle}>
								<span style={fieldLabelStyle}>Model</span>
								<select
									style={selectStyle}
									value={coderConfig.model}
									onChange={(e) =>
										setCoderConfig((prev) => (prev ? { ...prev, model: e.target.value } : prev))
									}
								>
									{models.map((m) => (
										<option key={m.id} value={m.id}>
											{m.label}
										</option>
									))}
								</select>
							</div>
							<div style={fieldRowStyle}>
								<span style={fieldLabelStyle}>Thinking tokens</span>
								<input
									type="number"
									style={numberInputStyle}
									value={coderConfig.maxThinkingTokens}
									min={1024}
									max={32768}
									step={1024}
									onChange={(e) =>
										setCoderConfig((prev) =>
											prev ? { ...prev, maxThinkingTokens: Number(e.target.value) } : prev,
										)
									}
								/>
							</div>
							<div style={fieldRowStyle}>
								<span style={fieldLabelStyle}>Max turns</span>
								<input
									type="number"
									style={numberInputStyle}
									value={coderConfig.maxTurns}
									min={1}
									max={500}
									onChange={(e) =>
										setCoderConfig((prev) =>
											prev ? { ...prev, maxTurns: Number(e.target.value) } : prev,
										)
									}
								/>
							</div>
							<div style={fieldRowStyle}>
								<span style={fieldLabelStyle}>Budget (USD)</span>
								<input
									type="number"
									style={numberInputStyle}
									value={coderConfig.maxBudgetUsd}
									min={0.5}
									max={200}
									step={0.5}
									onChange={(e) =>
										setCoderConfig((prev) =>
											prev ? { ...prev, maxBudgetUsd: Number(e.target.value) } : prev,
										)
									}
								/>
							</div>
						</div>

						<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
							<button
								type="button"
								className="primary"
								onClick={handleSaveModelSettings}
								disabled={savingModels}
								style={{ fontSize: 12 }}
							>
								{savingModels ? "Saving..." : modelSaved ? "Saved!" : "Save model settings"}
							</button>
							{modelError && (
								<span className="settings-error" style={{ margin: 0 }}>
									{modelError}
								</span>
							)}
						</div>
					</>
				)}

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
