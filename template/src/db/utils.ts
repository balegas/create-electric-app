import { sql } from "drizzle-orm"

/**
 * Get the current Postgres transaction ID. Used to correlate
 * optimistic updates with server-side writes via Electric sync.
 */
export async function generateTxId(tx: any): Promise<number> {
	const result = await tx.execute(sql`SELECT pg_current_xact_id()::text as txid`)
	const txid = result[0]?.txid
	if (txid === undefined) throw new Error("Failed to get transaction ID")
	return parseInt(txid as string, 10)
}

/**
 * Convert ISO date strings back to Date objects after JSON deserialization.
 * Use this in mutation routes: `const data = parseDates(await request.json())`
 *
 * When collections send data via fetch(), JSON.stringify turns Date objects
 * into ISO strings. Drizzle's timestamp columns expect Date objects, so
 * passing the raw JSON to db.insert() crashes with "toISOString is not a function".
 */
export function parseDates<T extends Record<string, unknown>>(obj: T): T {
	const result = { ...obj }
	for (const [key, value] of Object.entries(result)) {
		if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
			(result as Record<string, unknown>)[key] = new Date(value)
		}
	}
	return result as T
}
