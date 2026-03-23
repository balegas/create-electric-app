/** In-memory token store for session and room auth tokens. */

const sessionTokens = new Map<string, string>()
const roomTokens = new Map<string, string>()

export const tokenStore = {
	getSessionToken(id: string): string | undefined {
		return sessionTokens.get(id)
	},
	setSessionToken(id: string, token: string): void {
		sessionTokens.set(id, token)
	},
	getRoomToken(id: string): string | undefined {
		return roomTokens.get(id)
	},
	setRoomToken(id: string, token: string): void {
		roomTokens.set(id, token)
	},
}
