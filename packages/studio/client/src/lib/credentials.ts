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

/* Font size preference */
const FONT_SIZE_KEY = "electric-agent:font-size"

export type FontSize = "default" | "large" | "larger"

export function getFontSize(): FontSize {
	const val = localStorage.getItem(FONT_SIZE_KEY)
	if (val === "large" || val === "larger") return val
	return "default"
}

export function setFontSize(size: FontSize): void {
	if (size === "default") {
		localStorage.removeItem(FONT_SIZE_KEY)
	} else {
		localStorage.setItem(FONT_SIZE_KEY, size)
	}
}

export function applyFontSize(size?: FontSize): void {
	const s = size ?? getFontSize()
	document.documentElement.setAttribute("data-font-size", s)
}

/* Agent mode preference */
const AGENT_MODE_KEY = "electric-agent:agent-mode"

export type AgentMode = "claude-code" | "electric-agent"

export function getAgentMode(): AgentMode {
	const val = localStorage.getItem(AGENT_MODE_KEY)
	if (val === "electric-agent") return val
	return "claude-code"
}

export function setAgentMode(mode: AgentMode): void {
	if (mode === "claude-code") {
		localStorage.removeItem(AGENT_MODE_KEY)
	} else {
		localStorage.setItem(AGENT_MODE_KEY, mode)
	}
}
