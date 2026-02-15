import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

export const progress = new Hono()

// GET /:id — SSE stream of generation progress
progress.get("/:id", async (c) => {
	const id = c.req.param("id")

	return streamSSE(c, async (stream) => {
		// TODO: Phase 3 implementation
		// 1. Look up sandbox machine for this session
		// 2. Proxy SSE from sandbox agent → browser
		// 3. Transform SDK messages into progress events:
		//    - { event: "plan", data: "..." }
		//    - { event: "task", data: "..." }
		//    - { event: "build", data: "pass" | "fail" }
		//    - { event: "done", data: "..." }
		//    - { event: "error", data: "..." }

		await stream.writeSSE({
			event: "error",
			data: JSON.stringify({
				id,
				message: "not implemented",
			}),
		})
	})
})
