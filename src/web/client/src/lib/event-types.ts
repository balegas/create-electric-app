export type LogLevel = "plan" | "approve" | "task" | "build" | "fix" | "done" | "error" | "verbose"

export type EngineEvent =
	| { type: "log"; level: LogLevel; message: string; ts: string }
	| { type: "user_message"; message: string; ts: string }
	| {
			type: "tool_start"
			toolName: string
			toolUseId: string
			input: Record<string, unknown>
			agent?: string
			ts: string
	  }
	| { type: "tool_result"; toolUseId: string; output: string; agent?: string; ts: string }
	| { type: "assistant_text"; text: string; agent?: string; ts: string }
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
	| { type: "session_complete"; success: boolean; ts: string }
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
	| { kind: "user_message"; message: string }
	| {
			kind: "tool"
			toolName: string
			toolUseId: string
			input: Record<string, unknown>
			output: string | null
			agent?: string
			ts: string
	  }
	| { kind: "text"; text: string; agent?: string; ts: string }
	| { kind: "thinking"; text: string; agent?: string; ts: string }
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
