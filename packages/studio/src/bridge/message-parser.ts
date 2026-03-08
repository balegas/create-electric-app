/**
 * Parses agent output (assistant_message text) for @room or @<name> messages.
 *
 * Convention:
 *   @room <body>          → broadcast to all participants
 *   @<name> <body>        → direct message to a specific participant
 *   @room DONE: <summary> → signal conversation completion
 *   @room GATE: <question> → request human input
 *
 * If no @room/@name prefix is found, returns null (agent chose silence).
 * Uses the LAST match in the text so agents can do work first, then talk.
 */

export interface ParsedRoomMessage {
	/** Recipient name, or undefined for broadcast */
	to?: string
	/** Message body */
	body: string
	/** True if body starts with "DONE:" — signals conversation end */
	isDone: boolean
	/** True if body starts with "GATE:" — agent requests human input */
	isGateRequest: boolean
}

// Matches @room or @<name> at the start of a line, capturing the target and the rest of the line.
// The body extends to the end of the text (or until the next @room/@name match).
const ROOM_MESSAGE_RE = /^@(\S+)\s+([\s\S]*?)(?=\n@\S+\s|$)/gm

export function parseRoomMessage(
	text: string,
	_senderName: string,
	knownParticipants?: string[],
): ParsedRoomMessage | null {
	const matches: Array<{ target: string; body: string }> = []

	let match: RegExpExecArray | null = ROOM_MESSAGE_RE.exec(text)
	while (match !== null) {
		const target = match[1]
		const body = match[2].trim()

		// Only match @room or @<known participant name>
		if (target === "room" || knownParticipants?.includes(target)) {
			matches.push({ target, body })
		}
		match = ROOM_MESSAGE_RE.exec(text)
	}

	if (matches.length === 0) return null

	// Use the last match — agent does work first, then talks
	const last = matches[matches.length - 1]
	const to = last.target === "room" ? undefined : last.target
	const body = last.body
	const isDone = body.startsWith("DONE:")
	const isGateRequest = body.startsWith("GATE:")

	return { to, body, isDone, isGateRequest }
}
