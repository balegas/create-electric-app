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
	| { type: "user_prompt"; message: string; ts: string }
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
	| { type: "assistant_thinking"; text: string; agent?: string; ts: string }
	| {
			type: "clarification_needed"
			questions: string[]
			confidence: number
			summary: string
			ts: string
	  }
	| { type: "plan_ready"; plan: string; ts: string }
	| { type: "continue_needed"; reason: "max_turns" | "max_budget"; ts: string }
	| { type: "cost_update"; totalCostUsd: number; ts: string }
	| { type: "phase_complete"; phase: string; success: boolean; errors: string[]; ts: string }
	| { type: "session_end"; success: boolean; ts: string }
	| {
			type: "session_start"
			session_id: string
			cwd?: string
			agent?: string
			ts: string
	  }
	| { type: "app_ready"; port?: number; ts: string }
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
			ts: string
	  }
	| { type: "git_checkpoint"; commitHash: string; message: string; ts: string }
	| {
			type: "infra_config_prompt"
			projectName: string
			/** GitHub accounts available for repo creation (empty if gh not authenticated) */
			ghAccounts: { login: string; type: "user" | "org" }[]
			/** Sandbox runtime — "docker" supports local mode, cloud runtimes hide it */
			runtime: "docker" | "sprites" | "daytona"
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

export interface Participant {
	id: string
	displayName: string
}

export type SharedSessionEvent =
	| {
			type: "shared_session_created"
			name: string
			code: string
			createdBy: Participant
			ts: string
	  }
	| { type: "participant_joined"; participant: Participant; ts: string }
	| { type: "participant_left"; participantId: string; ts: string }
	| {
			type: "session_linked"
			sessionId: string
			/** Display name of the session (provided by the linking user) */
			sessionName: string
			/** Short description of the session */
			sessionDescription: string
			linkedBy: string
			ts: string
	  }
	| { type: "session_unlinked"; sessionId: string; ts: string }
	| { type: "code_revoked"; ts: string }

export function ts(): string {
	return new Date().toISOString()
}
