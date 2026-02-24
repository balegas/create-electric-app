export type LogLevel = "plan" | "approve" | "task" | "build" | "fix" | "done" | "error" | "verbose"

/**
 * Client-side mirror of the server's EngineEvent union.
 *
 * Type names and field names are aligned with Claude Code's hook event system
 * (PreToolUse, PostToolUse, SessionStart, etc.).
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
	| { type: "git_checkpoint"; commitHash: string; message: string; ts: string }
	| {
			type: "infra_config_prompt"
			projectName: string
			ghAccounts: { login: string; type: "user" | "org" }[]
			runtime: "docker" | "sprites" | "daytona"
			ts: string
	  }
	| {
			type: "gate_resolved"
			gate: string
			summary?: string
			details?: Record<string, string>
			ts: string
	  }

export type ConsoleEntry =
	| { kind: "log"; level: LogLevel; message: string; ts: string }
	| { kind: "user_prompt"; message: string }
	| {
			kind: "tool_use"
			tool_name: string
			tool_use_id: string
			tool_input: Record<string, unknown>
			tool_response: string | null
			agent?: string
			ts: string
	  }
	| { kind: "assistant_message"; text: string; agent?: string; ts: string }
	| { kind: "assistant_thinking"; text: string; agent?: string; ts: string }
	| {
			kind: "gate"
			event: Extract<
				EngineEvent,
				{
					type: "clarification_needed" | "plan_ready" | "continue_needed" | "infra_config_prompt"
				}
			>
			resolved: boolean
			/** Short summary of the decision, shown when collapsed */
			resolvedSummary?: string
			/** Structured key-value details of the gate decision */
			resolvedDetails?: Record<string, string>
			ts: string
	  }
