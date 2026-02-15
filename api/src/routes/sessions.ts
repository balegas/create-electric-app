import { Hono } from "hono"

export const sessions = new Hono()

// POST / — create a new generation session
sessions.post("/", async (c) => {
	const body = await c.req.json<{ description: string }>()

	// TODO: Phase 3 implementation
	// 1. Create Fly Machine from base image
	// 2. Upload scaffold into machine
	// 3. Start planner + coder agents
	// 4. Return session ID for SSE streaming

	return c.json(
		{ error: "not implemented", description: body.description },
		501,
	)
})

// GET /:id — get session status
sessions.get("/:id", async (c) => {
	const id = c.req.param("id")
	// TODO: look up session state from sandbox manager
	return c.json({ id, status: "not_implemented" }, 501)
})
