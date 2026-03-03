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
