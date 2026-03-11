import crypto from "node:crypto"

/**
 * Generate a cryptographically random 8-char invite code (e.g. "ABCD-1234").
 */
export function generateInviteCode(): string {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // No ambiguous chars (0/O, 1/I)
	const bytes = crypto.randomBytes(8)
	let code = ""
	for (let i = 0; i < 8; i++) {
		code += chars[bytes[i] % chars.length]
	}
	return `${code.slice(0, 4)}-${code.slice(4)}`
}
