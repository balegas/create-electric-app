import type { Participant } from "@electric-agent/protocol"

/**
 * Get or create a persistent participant identity stored in localStorage.
 */
export function getOrCreateParticipant(): Participant {
	let id = localStorage.getItem("participant-id")
	let displayName = localStorage.getItem("participant-name")
	if (!id) {
		id = crypto.randomUUID()
		localStorage.setItem("participant-id", id)
	}
	if (!displayName) {
		displayName = `User-${id.slice(0, 4)}`
		localStorage.setItem("participant-name", displayName)
	}
	return { id, displayName }
}

/**
 * Update the participant's display name.
 */
export function setParticipantName(name: string): void {
	localStorage.setItem("participant-name", name)
}
