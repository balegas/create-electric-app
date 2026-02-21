/**
 * Agent model configuration settings.
 *
 * Stored in-memory on the server and passed to containers via the NDJSON protocol.
 * Each agent (planner, coder) can be independently configured.
 */

export const AVAILABLE_MODELS = [
	{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", tier: "sonnet" },
	{ id: "claude-opus-4-6", label: "Claude Opus 4.6", tier: "opus" },
	{ id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", tier: "haiku" },
] as const

export type ModelId = (typeof AVAILABLE_MODELS)[number]["id"]

export interface PlannerModelConfig {
	model: ModelId
	maxThinkingTokens: number
	maxTurns: number
}

export interface CoderModelConfig {
	model: ModelId
	maxThinkingTokens: number
	maxTurns: number
	maxBudgetUsd: number
}

export interface AgentModelSettings {
	planner: PlannerModelConfig
	coder: CoderModelConfig
}

export const DEFAULT_PLANNER_CONFIG: PlannerModelConfig = {
	model: "claude-sonnet-4-6",
	maxThinkingTokens: 4096,
	maxTurns: 10,
}

export const DEFAULT_CODER_CONFIG: CoderModelConfig = {
	model: "claude-sonnet-4-6",
	maxThinkingTokens: 8192,
	maxTurns: 200,
	maxBudgetUsd: 25.0,
}

export const DEFAULT_MODEL_SETTINGS: AgentModelSettings = {
	planner: { ...DEFAULT_PLANNER_CONFIG },
	coder: { ...DEFAULT_CODER_CONFIG },
}
