import { Hono } from "hono"

export const download = new Hono()

// GET /:id — redirect to signed download URL
download.get("/:id", async (c) => {
	const id = c.req.param("id")

	// TODO: Phase 3 implementation
	// 1. Look up sandbox machine for this session
	// 2. Call handle.extractFiles() to package the project
	// 3. Upload to Tigris object storage
	// 4. Generate signed URL (24h expiry)
	// 5. Redirect to signed URL

	return c.json({ id, error: "not implemented" }, 501)
})
