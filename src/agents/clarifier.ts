import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

function toKebabCase(str: string): string {
	return str
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40)
}

/**
 * Infer a short, meaningful kebab-case project name from a description using an LLM.
 * Falls back to "electric-app" if the call fails or returns garbage.
 */
export async function inferProjectName(description: string): Promise<string> {
	let responseText = ""

	async function* generateMessages(): AsyncGenerator<SDKUserMessage> {
		yield {
			type: "user" as const,
			session_id: "",
			parent_tool_use_id: null,
			message: {
				role: "user" as const,
				content: `Given this app description, suggest a short project name (2-3 words, kebab-case, no prefix). Respond with only the name.\n\nDescription:\n"""\n${description}\n"""`,
			},
		}
	}

	try {
		for await (const message of query({
			prompt: generateMessages(),
			options: {
				model: "claude-haiku-4-5-20251001",
				systemPrompt:
					"You are a naming assistant. Given an app description, respond with a single short kebab-case project name (2-3 words). No explanation, no quotes, just the name.",
				maxTurns: 1,
				allowedTools: [],
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
			},
		})) {
			if (message.type === "assistant" && message.message?.content) {
				for (const block of message.message.content) {
					if ("text" in block && block.text) {
						responseText = block.text as string
					}
				}
			}
		}

		// Sanitize: extract first line, kebab-case it, validate
		const candidate = toKebabCase(responseText.trim().split("\n")[0])
		if (candidate.length >= 2 && /^[a-z]/.test(candidate)) {
			return candidate
		}
		return "electric-app"
	} catch {
		return "electric-app"
	}
}

export interface ClarificationResult {
	confidence: number
	summary: string
	questions: string[]
}

function extractJson(text: string): string {
	// Try to find JSON in code fences first
	const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
	if (fenceMatch) return fenceMatch[1].trim()

	// Try to find a JSON object
	const jsonMatch = text.match(/\{[\s\S]*\}/)
	if (jsonMatch) return jsonMatch[0]

	return text.trim()
}

/**
 * Evaluate a user's app description for clarity and completeness.
 * Returns a confidence score and optional clarification questions.
 */
export async function evaluateDescription(description: string): Promise<ClarificationResult> {
	let responseText = ""

	async function* generateMessages(): AsyncGenerator<SDKUserMessage> {
		yield {
			type: "user" as const,
			session_id: "",
			parent_tool_use_id: null,
			message: {
				role: "user" as const,
				content: `Evaluate the following application description and determine how clear and complete it is for building a reactive Electric SQL + TanStack DB application.

Description:
"""
${description}
"""

Respond with ONLY a JSON object (no markdown code fences, no other text) in this exact format:
{
  "confidence": <number 0-100>,
  "summary": "<one sentence summarizing what you understand the app to be>",
  "questions": ["<question 1>", "<question 2>", ...]
}

Scoring guidelines:
- 90-100: Very clear description with specific entities, relationships, and features
- 70-89: Reasonably clear, minor ambiguities that can be inferred
- 50-69: Missing key details about data model, features, or user interactions
- 0-49: Very vague or incomplete, needs significant clarification

If confidence >= 70, return an empty questions array.
If confidence < 70, ask 2-5 specific questions that would help clarify the app requirements. Focus on:
- What are the main entities/data objects?
- What are the key user interactions?
- What are the relationships between entities?
- Are there specific features or UI patterns expected?`,
			},
		}
	}

	for await (const message of query({
		prompt: generateMessages(),
		options: {
			model: "claude-sonnet-4-5-20250929",
			systemPrompt:
				"You are a requirements analyst. Evaluate app descriptions and identify ambiguities. Always respond with valid JSON only.",
			maxTurns: 1,
			allowedTools: [],
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
		},
	})) {
		if (message.type === "assistant" && message.message?.content) {
			for (const block of message.message.content) {
				if ("text" in block && block.text) {
					responseText = block.text as string
				}
			}
		}
	}

	try {
		const cleaned = extractJson(responseText)
		const parsed = JSON.parse(cleaned) as ClarificationResult
		return {
			confidence: typeof parsed.confidence === "number" ? parsed.confidence : 50,
			summary: parsed.summary || "",
			questions: Array.isArray(parsed.questions) ? parsed.questions : [],
		}
	} catch {
		// If parsing fails, assume low confidence
		return {
			confidence: 50,
			summary: "",
			questions: ["Could you describe in more detail what your application should do?"],
		}
	}
}
