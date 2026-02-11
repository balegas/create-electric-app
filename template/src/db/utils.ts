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
