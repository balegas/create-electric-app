export type LogLevel = "plan" | "approve" | "task" | "build" | "fix" | "done" | "error" | "verbose"

/**
 * Events emitted by the engine orchestrator.
 * These are the single source of truth for both CLI output and web UI streaming.
 */
export type EngineEvent =
	| { type: "log"; level: LogLevel; message: string; ts: string }
	| { type: "user_message"; message: string; ts: string }
	| {
			type: "tool_start"
			toolName: string
			toolUseId: string
			input: Record<string, unknown>
			ts: string
	  }
	| { type: "tool_result"; toolUseId: string; output: string; ts: string }
	| { type: "assistant_text"; text: string; ts: string }
	| { type: "assistant_thinking"; text: string; ts: string }
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
	| { type: "session_complete"; success: boolean; ts: string }
	| { type: "app_ready"; port?: number; ts: string }
	| { type: "git_checkpoint"; commitHash: string; message: string; ts: string }
	| {
			type: "infra_config_prompt"
			projectName: string
			/** GitHub accounts available for repo creation (empty if gh not authenticated) */
			ghAccounts: { login: string; type: "user" | "org" }[]
			ts: string
	  }
	| { type: "gate_resolved"; gate: string; summary?: string; ts: string }

export function ts(): string {
	return new Date().toISOString()
}
