import { useCallback, useState } from "react"
import { type TuiConfig, loadConfig, saveConfig } from "../lib/config.js"

export function useConfig() {
	const [config, setConfig] = useState<TuiConfig>(() => loadConfig())

	const updateConfig = useCallback((updates: Partial<TuiConfig>) => {
		setConfig((prev) => {
			const next = {
				...prev,
				...updates,
				credentials: { ...prev.credentials, ...updates.credentials },
				participant: { ...prev.participant, ...updates.participant },
			}
			saveConfig(next)
			return next
		})
	}, [])

	const updateCredentials = useCallback(
		(creds: Partial<TuiConfig["credentials"]>) => {
			updateConfig({ credentials: creds })
		},
		[updateConfig],
	)

	return { config, updateConfig, updateCredentials }
}
