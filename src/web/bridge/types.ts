import type { EngineEvent } from "../../engine/events.js"

/**
 * Bidirectional communication bridge between the web server and a sandbox.
 *
 * All messages flow through a single Durable Stream. Messages are tagged
 * with a `source` field to distinguish server-originated vs agent-originated:
 *
 *   source: "server" — commands and gate responses from the web server
 *   source: "agent"  — engine events from the sandbox
 *
 * The bridge handles filtering so consumers only see relevant messages.
 */
export interface SessionBridge {
	/** The session this bridge is associated with */
	readonly sessionId: string

	/**
	 * Full stream URL for client SSE subscription.
	 * The React client subscribes to this for real-time event display.
	 */
	readonly streamUrl: string

	/**
	 * Headers required for stream access (e.g., Authorization).
	 * Needed by the React client for SSE subscription.
	 */
	readonly streamHeaders: Record<string, string>

	/**
	 * Emit a server-originated event to the stream.
	 * These are visible to UI subscribers (e.g., user_message, gate_resolved).
	 */
	emit(event: EngineEvent): Promise<void>

	/**
	 * Send a command to the sandbox.
	 * The sandbox's headless adapter filters for these.
	 */
	sendCommand(cmd: Record<string, unknown>): Promise<void>

	/**
	 * Send a gate response to the sandbox.
	 * Resolves a pending gate in the headless adapter.
	 */
	sendGateResponse(gate: string, value: Record<string, unknown>): Promise<void>

	/**
	 * Register a callback for agent-originated events.
	 * The bridge filters stream messages and dispatches only `source: "agent"` events.
	 * Multiple callbacks can be registered.
	 */
	onAgentEvent(cb: (event: EngineEvent) => void): void

	/**
	 * Register a callback for session completion.
	 * Fired when a `session_end` event is received from the agent.
	 */
	onComplete(cb: (success: boolean) => void): void

	/**
	 * Start listening for agent events on the stream.
	 * Must be called after registering callbacks.
	 * Returns a promise that resolves when the subscription is active.
	 */
	start(): Promise<void>

	/**
	 * Close the bridge and release resources.
	 * Cancels any active subscriptions.
	 */
	close(): void
}

/**
 * A stream message with source tagging for the bidirectional protocol.
 */
export interface StreamMessage {
	source: "agent" | "server"
	[key: string]: unknown
}

/**
 * Server-originated command message.
 */
export interface ServerCommand extends StreamMessage {
	source: "server"
	type: "command"
	[key: string]: unknown
}

/**
 * Server-originated gate response message.
 */
export interface ServerGateResponse extends StreamMessage {
	source: "server"
	type: "gate_response"
	gate: string
	[key: string]: unknown
}

/**
 * Agent-originated event message (EngineEvent + source tag).
 */
export interface AgentEvent extends StreamMessage {
	source: "agent"
	type: string
	ts: string
	[key: string]: unknown
}
