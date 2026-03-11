export type LogLevel = "plan" | "approve" | "task" | "build" | "fix" | "done" | "error" | "verbose"

/**
 * Events emitted by the engine orchestrator.
 * These are the single source of truth for both CLI output and web UI streaming.
 *
 * Type names and field names are aligned with Claude Code's hook event system
 * (PreToolUse, PostToolUse, SessionStart, etc.) so that a local bridge between
 * Claude Code hooks and this stream is a trivial pass-through.
 */
export type EngineEvent =
	| { type: "log"; level: LogLevel; message: string; ts: string }
	| { type: "user_prompt"; message: string; sender?: string; ts: string }
	| {
			type: "pre_tool_use"
			tool_name: string
			tool_use_id: string
			tool_input: Record<string, unknown>
			agent?: string
			ts: string
	  }
	| {
			type: "post_tool_use"
			tool_use_id: string
			tool_name?: string
			tool_response: string
			/** Present when the tool produced an error (distinguishes failure from success) */
			error?: string
			agent?: string
			ts: string
	  }
	| {
			type: "post_tool_use_failure"
			tool_use_id: string
			tool_name: string
			error: string
			agent?: string
			ts: string
	  }
	| { type: "assistant_message"; text: string; agent?: string; ts: string }
	| {
			type: "session_end"
			success: boolean
			/** Total cost of the session in USD (from Claude Code result) */
			cost_usd?: number
			/** Number of agentic turns in the session */
			num_turns?: number
			/** Wall-clock duration in milliseconds */
			duration_ms?: number
			/** API-only duration in milliseconds */
			duration_api_ms?: number
			ts: string
	  }
	| {
			type: "session_start"
			session_id: string
			cwd?: string
			agent?: string
			ts: string
	  }
	| {
			type: "app_status"
			status: "running" | "stopped"
			port?: number
			previewUrl?: string
			ts: string
	  }
	| {
			type: "todo_write"
			tool_use_id: string
			todos: Array<{ id: string; content: string; status: string; priority?: string }>
			ts: string
	  }
	| {
			type: "ask_user_question"
			tool_use_id: string
			question: string
			options?: Array<{ label: string; description?: string }>
			/** Full questions array from Claude Code's AskUserQuestion tool */
			questions?: AskUserQuestionItem[]
			ts: string
	  }
	| { type: "git_checkpoint"; commitHash: string; message: string; ts: string }
	| {
			type: "infra_config_prompt"
			projectName: string
			/** GitHub accounts available for repo creation (empty if gh not authenticated) */
			ghAccounts: { login: string; type: "user" | "org" }[]
			/** Sandbox runtime — "docker" supports local mode, cloud runtimes hide it */
			runtime: "docker" | "sprites"
			ts: string
	  }
	| {
			type: "gate_resolved"
			gate: string
			summary?: string
			/** Structured key-value details of the gate decision (e.g. infra mode, repo) */
			details?: Record<string, string>
			/** Who resolved the gate (for shared session attribution) */
			resolvedBy?: Participant
			ts: string
	  }
	| {
			/** Outbound message gate: agent wants to send a @room message,
			 *  human can approve, edit, or drop it before it reaches the room */
			type: "outbound_message_gate"
			gateId: string
			roomId: string
			/** Intended recipient (omit for broadcast) */
			to?: string
			/** The message the agent wants to send */
			body: string
			ts: string
	  }
	| {
			type: "outbound_message_gate_resolved"
			gateId: string
			action: "approve" | "edit" | "drop"
			editedBody?: string
			resolvedBy?: string
			ts: string
	  }

export interface AskUserQuestionItem {
	question: string
	header?: string
	options?: Array<{ label: string; description?: string }>
	multiSelect?: boolean
}

export interface Participant {
	id: string
	displayName: string
}

export type RoomEvent =
	| {
			type: "room_created"
			name: string
			code: string
			createdBy: Participant
			ts: string
	  }
	| { type: "participant_joined"; participant: Participant; ts: string }
	| { type: "participant_left"; participantId: string; ts: string }
	| {
			/** Agent-to-agent message on a room stream */
			type: "agent_message"
			from: string
			/** Specific recipient name, or omit for broadcast */
			to?: string
			body: string
			metadata?: Record<string, unknown>
			ts: string
	  }
	| {
			type: "room_closed"
			summary?: string
			closedBy: string
			ts: string
	  }

export function ts(): string {
	return new Date().toISOString()
}
