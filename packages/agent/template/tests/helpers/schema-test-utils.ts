import type { ZodObject, ZodRawShape, ZodTypeAny } from "zod"

// Re-export parseDates so tests can import from the test helper
export { parseDates } from "@/db/utils"

/**
 * Generate a valid row from a Zod schema by introspecting its shape.
 * Produces type-appropriate default values for each field.
 */
export function generateValidRow<T extends ZodRawShape>(
	schema: ZodObject<T>,
): Record<string, unknown> {
	const shape = schema.shape
	const row: Record<string, unknown> = {}

	for (const [key, zodType] of Object.entries(shape)) {
		row[key] = generateValueForType(key, zodType as ZodTypeAny)
	}

	return row
}

/**
 * Generate a valid row with a specific field omitted.
 * Useful for negative tests that verify required fields.
 */
export function generateRowWithout<T extends ZodRawShape>(
	schema: ZodObject<T>,
	field: string,
): Record<string, unknown> {
	const row = generateValidRow(schema)
	delete row[field]
	return row
}

/**
 * Resolve the type name from a Zod schema's internal _def.
 * Handles both Zod v3 (_def.typeName = "ZodString") and
 * Zod v4 (_def.type = "string") conventions.
 */
function resolveTypeName(def: Record<string, unknown>): string | undefined {
	// Zod v3: _def.typeName is PascalCase like "ZodString"
	if (typeof def.typeName === "string") return def.typeName
	// Zod v4: _def.type is lowercase like "string"
	if (typeof def.type === "string") {
		const t = def.type as string
		return `Zod${t.charAt(0).toUpperCase()}${t.slice(1)}`
	}
	return undefined
}

function generateValueForType(key: string, zodType: ZodTypeAny): unknown {
	// Unwrap optional/nullable/default wrappers to find the inner type
	const inner = unwrap(zodType)
	const typeName = inner._def ? resolveTypeName(inner._def as Record<string, unknown>) : undefined

	// UUID fields — id, *Id (camelCase), or *_id (snake_case)
	if (key === "id" || key.endsWith("Id") || key.endsWith("_id")) {
		return crypto.randomUUID()
	}

	// Timestamp fields
	if (key === "createdAt" || key === "updatedAt" || key.endsWith("_at") || key.endsWith("At")) {
		return new Date()
	}

	switch (typeName) {
		case "ZodString":
			return `test-${key}`
		case "ZodNumber":
		case "ZodFloat":
			return 0
		case "ZodInt":
			return 0
		case "ZodBoolean":
			return false
		case "ZodDate":
			return new Date()
		case "ZodEnum":
			// Return the first enum value
			return inner._def?.values?.[0] ?? "unknown"
		case "ZodArray":
			return []
		case "ZodUUID":
			return crypto.randomUUID()
		default:
			return `test-${key}`
	}
}

function unwrap(zodType: ZodTypeAny): ZodTypeAny {
	const def = zodType._def as Record<string, unknown> | undefined
	if (!def) return zodType

	const typeName = resolveTypeName(def)
	if (typeName === "ZodOptional" || typeName === "ZodNullable" || typeName === "ZodDefault") {
		return unwrap(def.innerType as ZodTypeAny)
	}

	// Zod v4 ZodUnion: unwrap to first option (e.g., z.union([z.date(), z.string()]) → z.date())
	if (typeName === "ZodUnion" && Array.isArray(def.options)) {
		return unwrap(def.options[0] as ZodTypeAny)
	}

	return zodType
}
