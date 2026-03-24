import { ElectricAgentClient, type TokenStore } from "@electric-agent/protocol/client"
import { getApiKey, getGhToken, getOauthToken } from "./credentials"
import { getOrCreateParticipant } from "./participant"
import { getRoomToken, getSessionToken, setRoomToken, setSessionToken } from "./session-store"

// Re-export types that callers import from this module
export type {
	GhBranch,
	GhRepo,
	GitStatus,
	ProvisionResult,
	RoomState,
	SessionGitState,
	SessionInfo,
	StudioConfig,
} from "@electric-agent/protocol/client"

// ---------------------------------------------------------------------------
// Dev-mode flag (controls credential flow)
// ---------------------------------------------------------------------------

/** Whether we're in dev mode — defaults to false (safe: don't send credentials until confirmed) */
let _devMode = false

export function setDevMode(mode: boolean) {
	_devMode = mode
}

// ---------------------------------------------------------------------------
// Browser token store — bridges localStorage to the protocol client
// ---------------------------------------------------------------------------

const browserTokenStore: TokenStore = {
	getSessionToken,
	setSessionToken,
	getRoomToken,
	setRoomToken,
}

// ---------------------------------------------------------------------------
// Client instance
// ---------------------------------------------------------------------------

const client = new ElectricAgentClient({
	baseUrl: "/api",
	credentials: () => {
		const fields: {
			apiKey?: string
			oauthToken?: string
			ghToken?: string
		} = {}
		const apiKey = getApiKey()
		const oauthToken = getOauthToken()
		const ghToken = getGhToken()
		if (_devMode) {
			// Dev: full credential flow — OAuth takes priority over API key
			if (oauthToken) fields.oauthToken = oauthToken
			else if (apiKey) fields.apiKey = apiKey
		} else {
			// Prod: only send API key as fallback (server uses env/keychain first)
			if (apiKey) fields.apiKey = apiKey
		}
		if (ghToken) fields.ghToken = ghToken
		return fields
	},
	participant: () => getOrCreateParticipant(),
	tokenStore: browserTokenStore,
})

export { client }

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const fetchConfig = () => client.getConfig()
export const fetchKeychainCredentials = () => client.fetchKeychainCredentials()

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

export const getSession = (id: string) => client.getSession(id)
export const createSession = (description: string, name?: string, freeform?: boolean) =>
	client.createSession(description, name, freeform)
export const createLocalSession = (description?: string) => client.createLocalSession(description)
export const sendIterate = (sessionId: string, userRequest: string) =>
	client.sendIterate(sessionId, userRequest)
export const respondToGate = (sessionId: string, gate: string, data: Record<string, unknown>) =>
	client.respondToGate(sessionId, gate, data)
export const interruptSession = (sessionId: string) => client.interruptSession(sessionId)
export const cancelSession = (sessionId: string) => client.cancelSession(sessionId)
export const deleteSession = (sessionId: string) => client.deleteSession(sessionId)

// ---------------------------------------------------------------------------
// App status
// ---------------------------------------------------------------------------

export const startApp = (sessionId: string) => client.startApp(sessionId)
export const stopApp = (sessionId: string) => client.stopApp(sessionId)

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export const createAppRoom = (description: string, name?: string) =>
	client.createAppRoom(description, name)
export const createAgentRoom = (name: string, maxRounds?: number) =>
	client.createAgentRoom(name, maxRounds)
export const joinAgentRoom = (id: string, code: string) => client.joinAgentRoom(id, code)
export const getAgentRoomState = (roomId: string) => client.getAgentRoomState(roomId)
export const addAgentToRoom = (
	roomId: string,
	config: Parameters<typeof client.addAgentToRoom>[1],
) => client.addAgentToRoom(roomId, config)
export const sendRoomMessage = (roomId: string, from: string, body: string, to?: string) =>
	client.sendRoomMessage(roomId, from, body, to)
export const closeAgentRoom = (roomId: string) => client.closeAgentRoom(roomId)
export const setAutoIterate = (roomId: string, enabled: boolean) =>
	client.setAutoIterate(roomId, enabled)
export const deliverRoomMessage = (roomId: string, from: string, body: string, to?: string) =>
	client.deliverRoomMessage(roomId, from, body, to)
export const addSessionToRoom = (
	roomId: string,
	config: Parameters<typeof client.addSessionToRoom>[1],
) => client.addSessionToRoom(roomId, config)
export const iterateRoomSession = (roomId: string, sessionId: string, userRequest: string) =>
	client.iterateRoomSession(roomId, sessionId, userRequest)

// ---------------------------------------------------------------------------
// GitHub & provisioning
// ---------------------------------------------------------------------------

export const fetchGhAccounts = () => client.fetchGhAccounts()
export const provisionElectric = () => client.provisionElectric()
export const getGitStatus = (sessionId: string) => client.getGitStatus(sessionId)
export const listGithubRepos = () => client.listGithubRepos()
export const listBranches = (repoFullName: string) => client.listBranches(repoFullName)
export const resumeFromGithub = (repoUrl: string, branch?: string) =>
	client.resumeFromGithub(repoUrl, branch)
