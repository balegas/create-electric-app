import type { ZodObject, ZodRawShape, ZodTypeAny } from "zod"

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

function generateValueForType(key: string, zodType: ZodTypeAny): unknown {
	// Unwrap optional/nullable/default wrappers to find the inner type
	const inner = unwrap(zodType)
	const typeName = inner._def?.typeName as string | undefined

	// UUID fields — id or *Id
	if (key === "id" || key.endsWith("Id")) {
		return crypto.randomUUID()
	}

	// Timestamp fields
	if (
		key === "createdAt" ||
		key === "updatedAt" ||
		key.endsWith("_at") ||
		key.endsWith("At")
	) {
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
	const typeName = zodType._def?.typeName as string | undefined
	if (
		typeName === "ZodOptional" ||
		typeName === "ZodNullable" ||
		typeName === "ZodDefault"
	) {
		return unwrap(zodType._def.innerType)
	}
	return zodType
}
