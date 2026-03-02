import crypto from "node:crypto"

export function deriveSessionToken(secret: string, sessionId: string): string {
	return crypto.createHmac("sha256", secret).update(sessionId).digest("hex")
}

export function validateSessionToken(secret: string, sessionId: string, token: string): boolean {
	const expected = deriveSessionToken(secret, sessionId)
	if (expected.length !== token.length) return false
	return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(token, "hex"))
}
