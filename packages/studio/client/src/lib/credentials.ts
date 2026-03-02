/**
 * Client-side credential storage via localStorage.
 *
 * User-provided API keys never leave the browser except when sent
 * as part of a session creation request (to be forwarded to the sandbox).
 */

const ANTHROPIC_KEY = "electric-agent:anthropic-api-key"
const OAUTH_TOKEN_KEY = "electric-agent:oauth-token"
const OAUTH_MANUAL_KEY = "electric-agent:oauth-manual"
const GH_TOKEN_KEY = "electric-agent:gh-token"
const OPENAI_KEY = "electric-agent:openai-api-key"

export function getApiKey(): string | null {
	return localStorage.getItem(ANTHROPIC_KEY)
}

export function setApiKey(key: string): void {
	localStorage.setItem(ANTHROPIC_KEY, key)
}

export function clearApiKey(): void {
	localStorage.removeItem(ANTHROPIC_KEY)
}

export function hasApiKey(): boolean {
	return !!getApiKey()
}

export function getOauthToken(): string | null {
	return localStorage.getItem(OAUTH_TOKEN_KEY)
}

export function setOauthToken(token: string): void {
	localStorage.setItem(OAUTH_TOKEN_KEY, token)
}

export function clearOauthToken(): void {
	localStorage.removeItem(OAUTH_TOKEN_KEY)
	localStorage.removeItem(OAUTH_MANUAL_KEY)
}

export function setManualOauthToken(token: string): void {
	localStorage.setItem(OAUTH_TOKEN_KEY, token)
	localStorage.setItem(OAUTH_MANUAL_KEY, "1")
}

export function isManualOauth(): boolean {
	return localStorage.getItem(OAUTH_MANUAL_KEY) === "1"
}

export function hasAnyAuth(): boolean {
	return !!getApiKey() || !!getOauthToken()
}

export function getGhToken(): string | null {
	return localStorage.getItem(GH_TOKEN_KEY)
}

export function setGhToken(token: string): void {
	localStorage.setItem(GH_TOKEN_KEY, token)
}

export function clearGhToken(): void {
	localStorage.removeItem(GH_TOKEN_KEY)
}

export function hasGhToken(): boolean {
	return !!getGhToken()
}

/* OpenAI API Key (for Codex mode) */

export function getOpenaiApiKey(): string | null {
	return localStorage.getItem(OPENAI_KEY)
}

export function setOpenaiApiKey(key: string): void {
	localStorage.setItem(OPENAI_KEY, key)
}

export function clearOpenaiApiKey(): void {
	localStorage.removeItem(OPENAI_KEY)
}

export function hasOpenaiApiKey(): boolean {
	return !!getOpenaiApiKey()
}

/* Agent mode preference */
const AGENT_MODE_KEY = "electric-agent:agent-mode"

export type AgentMode = "claude-code" | "electric-agent" | "codex"

export function getAgentMode(): AgentMode {
	const val = localStorage.getItem(AGENT_MODE_KEY)
	if (val === "electric-agent" || val === "codex") return val
	return "claude-code"
}

export function setAgentMode(mode: AgentMode): void {
	if (mode === "claude-code") {
		localStorage.removeItem(AGENT_MODE_KEY)
	} else {
		localStorage.setItem(AGENT_MODE_KEY, mode)
	}
}
