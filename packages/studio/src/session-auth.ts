import crypto from "node:crypto"

export function deriveSessionToken(secret: string, sessionId: string): string {
	return crypto.createHmac("sha256", secret).update(sessionId).digest("hex")
}

export function validateSessionToken(secret: string, sessionId: string, token: string): boolean {
	const expected = deriveSessionToken(secret, sessionId)
	if (expected.length !== token.length) return false
	return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(token, "hex"))
}

/** Derive a purpose-scoped token for hook-event authentication. */
export function deriveHookToken(secret: string, sessionId: string): string {
	return crypto.createHmac("sha256", secret).update(`hook:${sessionId}`).digest("hex")
}

export function validateHookToken(secret: string, sessionId: string, token: string): boolean {
	const expected = deriveHookToken(secret, sessionId)
	if (expected.length !== token.length) return false
	return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(token, "hex"))
}

/** Derive a global hook secret for authenticating the unified /api/hook endpoint. */
export function deriveGlobalHookSecret(secret: string): string {
	return crypto.createHmac("sha256", secret).update("global-hook").digest("hex")
}

export function validateGlobalHookSecret(secret: string, token: string): boolean {
	const expected = deriveGlobalHookSecret(secret)
	if (expected.length !== token.length) return false
	return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(token, "hex"))
}
