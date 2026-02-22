/**
 * Cloudflare Pages _worker.js entry point (Advanced Mode).
 *
 * - Proxies /api/* requests to the backend server (API_BACKEND_URL).
 * - Serves static SPA assets via the ASSETS binding.
 * - Falls back to index.html for client-side routes.
 */

interface Env {
	API_BACKEND_URL: string
	ASSETS: { fetch: typeof fetch }
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)

		// Proxy API requests to the backend
		if (url.pathname.startsWith("/api/")) {
			return proxyToBackend(request, url, env.API_BACKEND_URL)
		}

		// Serve static assets, fall back to index.html for SPA routes
		return serveAsset(request, url, env.ASSETS)
	},
}

async function proxyToBackend(request: Request, url: URL, backendUrl: string): Promise<Response> {
	const target = new URL(url.pathname + url.search, backendUrl)

	const headers = new Headers(request.headers)
	headers.set("host", target.host)
	headers.delete("cf-connecting-ip")

	const init: RequestInit = {
		method: request.method,
		headers,
	}

	// Forward body for non-GET/HEAD requests
	if (request.method !== "GET" && request.method !== "HEAD") {
		init.body = request.body
	}

	try {
		const response = await fetch(target.toString(), init)

		// For SSE streams, pass through without buffering
		const contentType = response.headers.get("content-type") ?? ""
		if (contentType.includes("text/event-stream")) {
			return new Response(response.body, {
				status: response.status,
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					"access-control-allow-origin": "*",
				},
			})
		}

		return response
	} catch {
		return new Response(JSON.stringify({ error: "Backend unavailable" }), {
			status: 502,
			headers: { "content-type": "application/json" },
		})
	}
}

async function serveAsset(
	request: Request,
	url: URL,
	assets: { fetch: typeof fetch },
): Promise<Response> {
	// Try serving the exact static asset
	const response = await assets.fetch(request)
	if (response.status !== 404) {
		return response
	}

	// SPA fallback: serve index.html for client-side routes
	const indexUrl = new URL("/index.html", url.origin)
	return assets.fetch(new Request(indexUrl, request))
}
