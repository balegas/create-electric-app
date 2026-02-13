export type LogLevel = "plan" | "approve" | "task" | "build" | "fix" | "done" | "error" | "debug"

export type EngineEvent =
	| { type: "log"; level: LogLevel; message: string; ts: string }
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
	| { type: "phase_complete"; phase: string; success: boolean; errors: string[]; ts: string }
	| { type: "session_complete"; success: boolean; ts: string }

export type ConsoleEntry =
	| { kind: "log"; level: LogLevel; message: string }
	| {
			kind: "tool"
			toolName: string
			toolUseId: string
			input: Record<string, unknown>
			output: string | null
	  }
	| { kind: "text"; text: string }
	| {
			kind: "gate"
			event: Extract<
				EngineEvent,
				{ type: "clarification_needed" | "plan_ready" | "continue_needed" }
			>
			resolved: boolean
	  }
