/**
 * Zod schemas for API request body validation.
 *
 * Each schema corresponds to a POST endpoint in server.ts.
 * Using `.passthrough()` where backwards-compat matters (unknown fields ignored).
 */

import { z } from "zod"

/** Max length for free-text fields to prevent abuse */
const MAX_TEXT = 10_000
const MAX_SHORT = 500
const MAX_KEY = 1_000

const optionalKey = z.string().max(MAX_KEY).optional()

// POST /api/sessions
export const createSessionSchema = z.object({
	description: z.string().min(1).max(MAX_TEXT),
	name: z.string().max(MAX_SHORT).optional(),
	baseDir: z.string().max(MAX_SHORT).optional(),
	freeform: z.boolean().optional(),
	apiKey: optionalKey,
	oauthToken: optionalKey,
	ghToken: optionalKey,
})

// POST /api/sessions/:id/iterate
export const iterateSessionSchema = z.object({
	request: z.string().min(1).max(MAX_TEXT),
})

// POST /api/sandboxes
const infraNoneSchema = z.object({ mode: z.literal("none") })
const infraLocalSchema = z.object({ mode: z.literal("local") })
const infraCloudSchema = z.object({
	mode: z.literal("cloud"),
	databaseUrl: z.string().max(MAX_KEY),
	electricUrl: z.string().max(MAX_KEY),
	sourceId: z.string().max(MAX_SHORT),
	secret: z.string().max(MAX_KEY),
})
const infraClaimSchema = z.object({
	mode: z.literal("claim"),
	databaseUrl: z.string().max(MAX_KEY),
	electricUrl: z.string().max(MAX_KEY),
	sourceId: z.string().max(MAX_SHORT),
	secret: z.string().max(MAX_KEY),
	claimId: z.string().max(MAX_SHORT),
})
const infraConfigSchema = z.discriminatedUnion("mode", [
	infraNoneSchema,
	infraLocalSchema,
	infraCloudSchema,
	infraClaimSchema,
])

export const createSandboxSchema = z.object({
	sessionId: z.string().uuid().optional(),
	projectName: z.string().max(MAX_SHORT).optional(),
	infra: infraConfigSchema.optional(),
})

// POST /api/rooms
export const createRoomSchema = z.object({
	name: z.string().min(1).max(MAX_SHORT),
	maxRounds: z.number().int().positive().optional(),
})

// POST /api/rooms/create-app
export const createAppRoomSchema = z.object({
	description: z.string().min(1).max(MAX_TEXT),
	name: z.string().max(MAX_SHORT).optional(),
	apiKey: optionalKey,
	oauthToken: optionalKey,
	ghToken: optionalKey,
})

// POST /api/rooms/:id/agents
export const addAgentSchema = z.object({
	name: z.string().max(MAX_SHORT).optional(),
	role: z.string().max(MAX_SHORT).optional(),
	gated: z.boolean().optional(),
	initialPrompt: z.string().max(MAX_TEXT).optional(),
	apiKey: optionalKey,
	oauthToken: optionalKey,
	ghToken: optionalKey,
})

// POST /api/rooms/:id/sessions
export const addSessionToRoomSchema = z.object({
	sessionId: z.string().uuid(),
	name: z.string().min(1).max(MAX_SHORT),
	initialPrompt: z.string().max(MAX_TEXT).optional(),
})

// POST /api/rooms/:id/sessions/:sessionId/iterate
export const iterateRoomSessionSchema = z.object({
	request: z.string().min(1).max(MAX_TEXT),
})

// POST /api/rooms/:id/messages
export const sendRoomMessageSchema = z.object({
	from: z.string().min(1).max(MAX_SHORT),
	body: z.string().min(1).max(MAX_TEXT),
	to: z.string().max(MAX_SHORT).optional(),
})

// POST /api/sessions/resume
export const resumeSessionSchema = z.object({
	repoUrl: z.string().min(1).max(MAX_KEY),
	branch: z.string().max(MAX_SHORT).optional(),
	apiKey: optionalKey,
	oauthToken: optionalKey,
	ghToken: optionalKey,
})
