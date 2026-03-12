import type { Context } from "hono"
import type { z } from "zod"

/**
 * Parse and validate a JSON request body against a Zod schema.
 * Returns the validated data or a 400 Response.
 */
export async function validateBody<T extends z.ZodType>(
	c: Context,
	schema: T,
): Promise<z.infer<T> | Response> {
	let raw: unknown
	try {
		raw = await c.req.json()
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400)
	}

	const result = schema.safeParse(raw)
	if (!result.success) {
		const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
		return c.json({ error: "Validation failed", details: issues }, 400)
	}
	return result.data
}

/** Type guard: returns true if the value is a Response (validation failed) */
export function isResponse(value: unknown): value is Response {
	return value instanceof Response
}
