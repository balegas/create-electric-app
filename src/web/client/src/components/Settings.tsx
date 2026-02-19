import { useCallback, useId, useState } from "react"
import { updateSettings } from "../lib/api"

interface SettingsProps {
	hasApiKey: boolean
	onKeySaved: () => void
}

export function Settings({ hasApiKey, onKeySaved }: SettingsProps) {
	const inputId = useId()
	const [apiKey, setApiKey] = useState("")
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const handleSave = useCallback(async () => {
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

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault()
				handleSave()
			}
		},
		[handleSave],
	)

	return (
		<div className="settings-panel">
			<div className="settings-header">
				<span className="settings-title">Settings</span>
				<span className={`settings-status ${hasApiKey ? "active" : "missing"}`}>
					{hasApiKey ? "API key set" : "No API key"}
				</span>
			</div>
			<div className="settings-field">
				<label htmlFor={inputId}>Anthropic API Key</label>
				<div className="settings-input-row">
					<input
						id={inputId}
						type="password"
						value={apiKey}
						onChange={(e) => setApiKey(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={hasApiKey ? "Enter new key to override..." : "sk-ant-..."}
						disabled={saving}
					/>
					<button onClick={handleSave} disabled={saving || !apiKey.trim()} className="primary">
						{saving ? "Saving..." : "Save"}
					</button>
				</div>
				{error && <div className="settings-error">{error}</div>}
			</div>
		</div>
	)
}
