/**
 * RoomRouter — routes agent-to-agent messages through a shared durable stream.
 *
 * Watches a room's durable stream for AgentMessage events and delivers them
 * to recipient agents via their session bridges. Supports optional per-agent
 * gating where a human must approve outbound messages before they reach the room.
 */

import crypto from "node:crypto"
import { DurableStream } from "@durable-streams/client"
import type { RoomEvent } from "@electric-agent/protocol"
import { ts } from "@electric-agent/protocol"
import { parseRoomMessage } from "./bridge/message-parser.js"
import type { SessionBridge } from "./bridge/types.js"
import { createGate } from "./gate.js"
import { getRoomStreamConnectionInfo, type StreamConfig } from "./streams.js"

export interface RoomParticipant {
	sessionId: string
	name: string
	role?: string
	bridge: SessionBridge
}

export interface RepoInfo {
	/** GitHub repository URL (e.g. https://github.com/org/repo) */
	url: string | null
	/** Branch the coder is working on (default: main) */
	branch: string
}

export interface RoomRouterOptions {
	/** Maximum rounds before the room auto-closes (default: 20) */
	maxRounds?: number
	/** Repository information to share with all agents at discovery time */
	repoInfo?: RepoInfo
}

export class RoomRouter {
	readonly roomId: string
	private readonly roomName: string
	private readonly streamConfig: StreamConfig
	private readonly maxRounds: number

	private readonly _participants = new Map<string, RoomParticipant>()
	private _repoInfo: RepoInfo | null
	private _state: "active" | "closed" = "active"
	private _roundCount = 0
	private cancelSubscription: (() => void) | null = null
	private stream: DurableStream

	constructor(
		roomId: string,
		roomName: string,
		streamConfig: StreamConfig,
		options?: RoomRouterOptions,
	) {
		this.roomId = roomId
		this.roomName = roomName
		this.streamConfig = streamConfig
		this.maxRounds = options?.maxRounds ?? 20
		this._repoInfo = options?.repoInfo ?? null

		const conn = getRoomStreamConnectionInfo(roomId, streamConfig)
		this.stream = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})
	}

	// --- Public API ---

	get participants(): RoomParticipant[] {
		return [...this._participants.values()]
	}

	get state(): "active" | "closed" {
		return this._state
	}

	get roundCount(): number {
		return this._roundCount
	}

	/**
	 * Update the repository info (e.g. after the GitHub repo is created).
	 */
	setRepoInfo(info: RepoInfo): void {
		this._repoInfo = info
	}

	/**
	 * Add an agent to the room.
	 * Reads stream history for discovery context, sends discovery prompt to agent.
	 */
	async addParticipant(participant: RoomParticipant): Promise<void> {
		this._participants.set(participant.sessionId, participant)

		// Read stream history for discovery context (non-live replay)
		const { roster, recentMessages } = await this.readStreamHistory()

		// Emit participant_joined to room stream
		const joinEvent: RoomEvent = {
			type: "participant_joined",
			participant: { id: participant.sessionId, displayName: participant.name },
			ts: ts(),
		}
		await this.stream.append(JSON.stringify(joinEvent))

		// Build and send discovery prompt
		const prompt = this.buildDiscoveryPrompt(participant, roster, recentMessages)
		await participant.bridge.sendCommand({
			command: "iterate",
			request: prompt,
		})

		// Notify other participants that this agent joined
		const roleSuffix = participant.role ? ` (${participant.role})` : ""
		for (const p of this._participants.values()) {
			if (p.sessionId !== participant.sessionId) {
				const joinMsg = `${participant.name}${roleSuffix} has joined the room.`
				await p.bridge.emit({
					type: "user_prompt",
					message: joinMsg,
					sender: "system",
					ts: ts(),
				})
			}
		}
	}

	/**
	 * Remove an agent from the room.
	 */
	async removeParticipant(sessionId: string): Promise<void> {
		const participant = this._participants.get(sessionId)
		if (!participant) return

		this._participants.delete(sessionId)

		const leaveEvent: RoomEvent = {
			type: "participant_left",
			participantId: sessionId,
			ts: ts(),
		}
		await this.stream.append(JSON.stringify(leaveEvent))

		// Notify remaining participants that this agent left
		const roleSuffix = participant.role ? ` (${participant.role})` : ""
		for (const p of this._participants.values()) {
			await p.bridge.emit({
				type: "user_prompt",
				message: `${participant.name}${roleSuffix} has left the room.`,
				sender: "system",
				ts: ts(),
			})
		}
	}

	/**
	 * Send a message to the room stream (from human, API, or system).
	 */
	async sendMessage(from: string, body: string, to?: string): Promise<void> {
		if (this._state === "closed") return

		const event: RoomEvent = {
			type: "agent_message",
			from,
			...(to ? { to } : {}),
			body,
			ts: ts(),
		}
		await this.stream.append(JSON.stringify(event))
	}

	/**
	 * Called by the server when an agent produces assistant_message output.
	 * Parses for @room messages and handles gating/delivery.
	 */
	async handleAgentOutput(sessionId: string, text: string): Promise<void> {
		if (this._state === "closed") {
			console.log(`[room-router:${this.roomId}] handleAgentOutput: room closed, ignoring`)
			return
		}

		const participant = this._participants.get(sessionId)
		if (!participant) {
			console.log(
				`[room-router:${this.roomId}] handleAgentOutput: no participant for sessionId=${sessionId}, known participants: ${[...this._participants.keys()].join(", ")}`,
			)
			return
		}

		const knownNames = [...this._participants.values()]
			.filter((p) => p.sessionId !== sessionId)
			.map((p) => p.name)

		console.log(
			`[room-router:${this.roomId}] handleAgentOutput: participant=${participant.name} knownNames=${knownNames.join(",")} text=${text.slice(0, 120)}`,
		)

		const parsed = parseRoomMessage(text, participant.name, knownNames)
		if (!parsed) {
			console.log(
				`[room-router:${this.roomId}] handleAgentOutput: no @room/@name found in text from ${participant.name}`,
			)
			return // Agent chose silence
		}

		console.log(
			`[room-router:${this.roomId}] handleAgentOutput: parsed @room message from ${participant.name}: to=${parsed.to ?? "broadcast"} isReviewRequest=${parsed.isReviewRequest} body=${parsed.body.slice(0, 80)}`,
		)

		let finalBody = parsed.body

		// Explicit GATE: request: block until human approves
		if (parsed.isGateRequest) {
			const gateId = `room-msg-${crypto.randomUUID()}`

			// Emit gate event on the agent's session stream
			await participant.bridge.emit({
				type: "outbound_message_gate",
				gateId,
				roomId: this.roomId,
				to: parsed.to,
				body: parsed.body,
				ts: ts(),
			})

			// Block until human resolves
			const resolution = await createGate<{
				action: "approve" | "edit" | "drop"
				editedBody?: string
			}>(sessionId, gateId)

			// Emit resolution on agent's session stream for replay
			await participant.bridge.emit({
				type: "outbound_message_gate_resolved",
				gateId,
				action: resolution.action,
				editedBody: resolution.editedBody,
				ts: ts(),
			})

			if (resolution.action === "drop") return
			if (resolution.action === "edit" && resolution.editedBody) {
				finalBody = resolution.editedBody
			}
		}

		// Append message to room stream
		await this.sendMessage(participant.name, finalBody, parsed.to)

		this._roundCount++

		// Safety net: enforce maxRounds to prevent runaway conversations
		if (this._roundCount >= this.maxRounds) {
			console.log(
				`[room-router:${this.roomId}] maxRounds (${this.maxRounds}) reached, auto-closing room`,
			)
			this._state = "closed"
		}
	}

	/**
	 * Start watching the room stream for new messages and routing them.
	 */
	async start(): Promise<void> {
		const conn = getRoomStreamConnectionInfo(this.roomId, this.streamConfig)
		const reader = new DurableStream({
			url: conn.url,
			headers: conn.headers,
			contentType: "application/json",
		})

		const response = await reader.stream<Record<string, unknown>>({
			offset: "-1",
			live: true,
		})

		this.cancelSubscription = response.subscribeJson<Record<string, unknown>>((batch) => {
			for (const item of batch.items) {
				if (item.type === "agent_message") {
					this.deliverMessage(
						item as unknown as {
							from: string
							to?: string
							body: string
						},
					).catch((err) => {
						console.error(`[room-router] delivery error:`, err)
					})
				}

				if (item.type === "room_closed") {
					this._state = "closed"
				}
			}
		})
	}

	/**
	 * Close the room.
	 */
	close(): void {
		this._state = "closed"
		if (this.cancelSubscription) {
			this.cancelSubscription()
			this.cancelSubscription = null
		}
	}

	/**
	 * Deliver a message to recipient agent(s) via their bridges.
	 */
	private async deliverMessage(msg: { from: string; to?: string; body: string }): Promise<void> {
		if (this._state === "closed") return

		// System messages are for the room UI only — don't deliver to agents
		if (msg.from === "system") return

		const deliverTo: RoomParticipant[] = []

		if (msg.to) {
			// Direct message: find the specific recipient by name
			const recipient = [...this._participants.values()].find((p) => p.name === msg.to)
			if (recipient) deliverTo.push(recipient)
		} else {
			// Broadcast: deliver to all except sender
			for (const p of this._participants.values()) {
				if (p.name !== msg.from) deliverTo.push(p)
			}
		}

		// Announce when agents pick up a task (visible in room timeline)
		const isReviewRequest = /^REVIEW_REQUEST:/m.test(msg.body)
		if (isReviewRequest && deliverTo.length > 0) {
			for (const p of deliverTo) {
				const action =
					p.role === "reviewer"
						? "starting review"
						: p.role === "ui-designer"
							? "starting UI audit"
							: "picking up task"
				await this.sendMessage("system", `${p.name} is ${action}`)
			}
		}

		const prompt = `Message from ${msg.from}:\n\n${msg.body}`

		await Promise.all(
			deliverTo.map(async (p) => {
				try {
					// Emit the incoming message to the agent's session stream
					// so it's visible in the session UI
					await p.bridge.emit({
						type: "user_prompt",
						message: msg.body,
						sender: msg.from,
						ts: ts(),
					})
					await p.bridge.sendCommand({ command: "iterate", request: prompt })
				} catch (err) {
					console.error(`[room-router] failed to deliver to ${p.name}:`, err)
				}
			}),
		)
	}

	/**
	 * Read the room stream history (non-live) for discovery context.
	 */
	private async readStreamHistory(): Promise<{
		roster: Array<{ name: string; role?: string }>
		recentMessages: Array<{ from: string; body: string }>
	}> {
		const roster: Array<{ name: string; role?: string }> = []
		const leftIds = new Set<string>()
		const messages: Array<{ from: string; body: string }> = []

		try {
			const conn = getRoomStreamConnectionInfo(this.roomId, this.streamConfig)
			const reader = new DurableStream({
				url: conn.url,
				headers: conn.headers,
				contentType: "application/json",
			})

			const response = await reader.stream<Record<string, unknown>>({
				offset: "-1",
				live: false,
			})

			// Read all available messages from the stream
			await new Promise<void>((resolve) => {
				const cancel = response.subscribeJson<Record<string, unknown>>((batch) => {
					for (const item of batch.items) {
						if (item.type === "participant_joined" && item.participant) {
							const p = item.participant as {
								id: string
								displayName: string
							}
							if (!leftIds.has(p.id)) {
								// Find role from our internal participants if available
								const internal = this._participants.get(p.id)
								roster.push({
									name: p.displayName,
									role: internal?.role,
								})
							}
						}
						if (item.type === "participant_left" && item.participantId) {
							leftIds.add(item.participantId as string)
						}
						if (item.type === "agent_message") {
							messages.push({
								from: item.from as string,
								body: item.body as string,
							})
						}
					}

					// Non-live stream: once we get a batch, check if there are more
					// For now, resolve after first batch since non-live streams
					// deliver all available data
					cancel()
					resolve()
				})

				// If there's nothing in the stream, resolve after a short timeout
				setTimeout(() => {
					cancel()
					resolve()
				}, 1000)
			})
		} catch (err) {
			console.error(`[room-router] failed to read stream history:`, err)
		}

		// Only return the last 10 messages
		const recentMessages = messages.slice(-10)
		return { roster, recentMessages }
	}

	/**
	 * Build the discovery prompt sent to an agent when it joins the room.
	 */
	private buildDiscoveryPrompt(
		self: RoomParticipant,
		roster: Array<{ name: string; role?: string }>,
		recentMessages: Array<{ from: string; body: string }>,
	): string {
		const others = roster.filter((p) => p.name !== self.name)
		const lines: string[] = [
			`You have joined room "${this.roomName}".`,
			`Your name in this room: ${self.name}`,
		]

		if (self.role) {
			lines.push(`Your role: ${self.role}`)
			// Coder already has its own skill at .claude/skills/create-app/SKILL.md
			// Only non-coder roles get a role skill injected at .claude/skills/role/
			if (self.role !== "coder") {
				lines.push(`Read .claude/skills/role/SKILL.md for your role-specific guidelines.`)
			}
		}

		lines.push("")

		if (this._repoInfo) {
			lines.push("Repository info:")
			if (this._repoInfo.url) {
				lines.push(`- URL: ${this._repoInfo.url}`)
			}
			lines.push(`- Branch: ${this._repoInfo.branch}`)
			lines.push("")
		}

		if (others.length > 0) {
			lines.push("Other participants:")
			for (const p of others) {
				lines.push(`- ${p.name}${p.role ? ` (${p.role})` : ""}`)
			}
		} else {
			lines.push("No other participants yet.")
		}

		lines.push("")

		if (recentMessages.length > 0) {
			lines.push("Recent conversation:")
			for (const m of recentMessages) {
				lines.push(`[${m.from}]: ${m.body}`)
			}
			lines.push("")
		}

		lines.push(
			"To send a message: @room <your message> (broadcast) or @<name> <message> (direct).",
			"Place your @room message at the END of your response, after completing any work.",
			"CRITICAL: The @room or @<name> directive MUST be on its own line — never inline in a paragraph. The parser only recognises directives at the start of a line.",
			"If you have nothing to say, finish without @room — your turn ends silently.",
			"To request human input: @room GATE: <question>",
			"",
			"Do NOT greet or make small talk. Announce your presence (see room-messaging skill), then wait for actionable work.",
		)

		return lines.join("\n")
	}
}
