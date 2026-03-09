export type {
	EngineEvent,
	LogLevel,
	Participant,
	SharedSessionEvent,
} from "@electric-agent/protocol"

import type { EngineEvent, LogLevel } from "@electric-agent/protocol"

// --- Console Entries ---

export type ConsoleEntry =
	| { kind: "log"; level: LogLevel; message: string; ts: string }
	| { kind: "user_prompt"; message: string; sender?: string }
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
	| {
			kind: "todo_widget"
			tool_use_id: string
			todos: Array<{ id: string; content: string; status: string; priority?: string }>
			ts: string
	  }
	| {
			kind: "gate"
			event: Extract<EngineEvent, { type: "infra_config_prompt" | "ask_user_question" }>
			resolved: boolean
			/** Short summary of the decision, shown when collapsed */
			resolvedSummary?: string
			/** Structured key-value details of the gate decision */
			resolvedDetails?: Record<string, string>
			ts: string
	  }
