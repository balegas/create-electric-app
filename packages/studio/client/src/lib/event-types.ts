export type {
	EngineEvent,
	LogLevel,
	Participant,
	SharedSessionEvent,
} from "@electric-agent/protocol"

import type { EngineEvent, LogLevel } from "@electric-agent/protocol"

// --- Registry Events (mirrored from server-side registry.ts) ---

export interface RegistrySessionInfo {
	id: string
	projectName: string
	sandboxProjectDir: string
	description: string
	createdAt: string
	lastActiveAt: string
	status: "running" | "complete" | "error" | "cancelled"
	appPort?: number
	previewUrl?: string
	claudeSessionId?: string
	claimId?: string
	git?: {
		branch: string
		remoteUrl: string | null
		repoName: string | null
		repoVisibility?: "public" | "private"
		lastCommitHash: string | null
		lastCommitMessage: string | null
		lastCheckpointAt: string | null
	}
	lastCoderSessionId?: string
}

export interface RegistryRoomInfo {
	id: string
	code: string
	createdAt: string
	revoked: boolean
}

export type RegistryEvent =
	| { type: "session_registered"; session: RegistrySessionInfo; ts: string }
	| { type: "session_updated"; sessionId: string; update: Partial<RegistrySessionInfo>; ts: string }
	| { type: "session_deleted"; sessionId: string; ts: string }
	| { type: "session_mapped"; transcriptPath: string; sessionId: string; ts: string }
	| { type: "room_created"; room: RegistryRoomInfo; ts: string }
	| { type: "room_revoked"; roomId: string; ts: string }

// --- Console Entries ---

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
			kind: "todo_widget"
			tool_use_id: string
			todos: Array<{ id: string; content: string; status: string; priority?: string }>
			ts: string
	  }
	| {
			kind: "gate"
			event: Extract<
				EngineEvent,
				{
					type:
						| "clarification_needed"
						| "plan_ready"
						| "continue_needed"
						| "infra_config_prompt"
						| "ask_user_question"
				}
			>
			resolved: boolean
			/** Short summary of the decision, shown when collapsed */
			resolvedSummary?: string
			/** Structured key-value details of the gate decision */
			resolvedDetails?: Record<string, string>
			ts: string
	  }
