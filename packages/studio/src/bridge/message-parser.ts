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

// Matches @room or @<name> at the start of a line, capturing just the target.
const ROOM_PREFIX_RE = /^@(\S+)\s/gm

export function parseRoomMessage(
	text: string,
	_senderName: string,
	knownParticipants?: string[],
): ParsedRoomMessage | null {
	// Find all @room / @name positions in the text
	const hits: Array<{ target: string; startOfBody: number }> = []

	// Reset lastIndex — /g regexes retain state between exec() calls
	ROOM_PREFIX_RE.lastIndex = 0
	let match: RegExpExecArray | null = ROOM_PREFIX_RE.exec(text)
	while (match !== null) {
		const target = match[1]
		if (target === "room" || knownParticipants?.includes(target)) {
			hits.push({ target, startOfBody: match.index + match[0].length })
		}
		match = ROOM_PREFIX_RE.exec(text)
	}

	if (hits.length === 0) return null

	// Use the last match — agent does work first, then talks
	const last = hits[hits.length - 1]

	// Body runs from after "@room " to end of string (or next hit, but we want the last one)
	const body = text.slice(last.startOfBody).trim()
	const to = last.target === "room" ? undefined : last.target
	const isDone = body.startsWith("DONE:")
	const isGateRequest = body.startsWith("GATE:")

	return { to, body, isDone, isGateRequest }
}
