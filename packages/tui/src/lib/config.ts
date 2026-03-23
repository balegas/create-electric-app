import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

export interface TuiConfig {
	server: string
	credentials: {
		apiKey?: string
		oauthToken?: string
		githubToken?: string
	}
	participant: {
		id: string
		displayName: string
	}
}

const DEFAULT_CONFIG_PATH = join(homedir(), ".electric-agent", "config.json")

let configPath = DEFAULT_CONFIG_PATH

export function setConfigPath(path: string) {
	configPath = path
}

export function getConfigPath() {
	return configPath
}

function generateId(): string {
	return crypto.randomUUID()
}

function defaultConfig(): TuiConfig {
	return {
		server: "http://localhost:4400",
		credentials: {},
		participant: {
			id: generateId(),
			displayName: process.env.USER ?? "user",
		},
	}
}

export function loadConfig(): TuiConfig {
	try {
		if (!existsSync(configPath)) {
			return defaultConfig()
		}
		const raw = readFileSync(configPath, "utf-8")
		const parsed = JSON.parse(raw) as Partial<TuiConfig>
		const defaults = defaultConfig()
		return {
			server: parsed.server ?? defaults.server,
			credentials: { ...defaults.credentials, ...parsed.credentials },
			participant: { ...defaults.participant, ...parsed.participant },
		}
	} catch {
		return defaultConfig()
	}
}

export function saveConfig(config: TuiConfig): void {
	const dir = dirname(configPath)
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true })
	}
	writeFileSync(configPath, JSON.stringify(config, null, "\t") + "\n", "utf-8")
}
