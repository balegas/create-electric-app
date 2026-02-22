/**
 * Cloudflare Pages _worker.js — thin reverse proxy + SPA server.
 *
 * Serves the React SPA from ASSETS and proxies all /api/* requests
 * to the Fly.io backend server, which handles sandbox management,
 * session state, and agent communication.
 */

import { Hono } from "hono"
import { cors } from "hono/cors"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
	ASSETS: { fetch: typeof fetch }
	/** Fly.io backend URL (e.g. "https://electric-agent.fly.dev") */
	API_BACKEND_URL: string
}

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>()

app.use("*", cors({ origin: "*" }))

// --- API proxy ---
// Forward all /api/* requests to the Fly.io backend

app.all("/api/*", async (c) => {
	const backendUrl = c.env.API_BACKEND_URL
	if (!backendUrl) {
		return c.json({ error: "API_BACKEND_URL not configured" }, 503)
	}

	const url = new URL(c.req.url)
	const target = `${backendUrl}${url.pathname}${url.search}`

	// Build headers, forwarding originals but overriding host
	const headers = new Headers(c.req.raw.headers)
	headers.delete("host")

	const init: RequestInit = {
		method: c.req.method,
		headers,
	}

	// Forward body for non-GET/HEAD requests
	if (c.req.method !== "GET" && c.req.method !== "HEAD") {
		init.body = c.req.raw.body
		// @ts-expect-error — Workers support duplex streaming
		init.duplex = "half"
	}

	const response = await fetch(target, init)

	// For SSE, pass through the streaming response directly
	if (response.headers.get("Content-Type")?.includes("text/event-stream")) {
		return new Response(response.body, {
			status: response.status,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"Access-Control-Allow-Origin": "*",
			},
		})
	}

	// Pass through the response with CORS headers
	const proxyHeaders = new Headers(response.headers)
	proxyHeaders.set("Access-Control-Allow-Origin", "*")

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: proxyHeaders,
	})
})

// --- Static assets ---

app.get("*", async (c) => {
	const response = await c.env.ASSETS.fetch(c.req.raw)
	if (response.status !== 404) return response
	// SPA fallback
	const url = new URL(c.req.url)
	const indexUrl = new URL("/index.html", url.origin)
	return c.env.ASSETS.fetch(new Request(indexUrl, c.req.raw))
})

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default {
	fetch: app.fetch,
}
