/**
 * Electric shape proxy helpers.
 * Used by API routes to forward shape requests to the Electric service.
 *
 * Supports both local Electric (Docker) and Electric Cloud.
 * For Electric Cloud, set these environment variables:
 *   ELECTRIC_URL=https://api.electric-sql.cloud
 *   ELECTRIC_SOURCE_ID=<your-source-id>
 *   ELECTRIC_SECRET=<your-secret>
 */

export function prepareElectricUrl(
	request: Request,
	tableName: string,
): string {
	const electricUrl = process.env.ELECTRIC_URL || "http://localhost:3000"
	const url = new URL(`${electricUrl}/v1/shape`)

	// Forward Electric-specific query parameters
	const requestUrl = new URL(request.url)
	for (const [key, value] of requestUrl.searchParams) {
		url.searchParams.set(key, value)
	}

	// Set the table name
	url.searchParams.set("table", tableName)

	// Add Electric Cloud auth if configured (server-side only, never exposed to browser)
	if (process.env.ELECTRIC_SOURCE_ID && process.env.ELECTRIC_SECRET) {
		url.searchParams.set("source_id", process.env.ELECTRIC_SOURCE_ID)
		url.searchParams.set("secret", process.env.ELECTRIC_SECRET)
	}

	return url.toString()
}

export async function proxyElectricRequest(
	request: Request,
	tableName: string,
): Promise<Response> {
	const url = prepareElectricUrl(request, tableName)

	const response = await fetch(url, {
		headers: {
			"Accept-Encoding": request.headers.get("Accept-Encoding") || "",
		},
	})

	return new Response(response.body, {
		status: response.status,
		headers: {
			"Content-Type": response.headers.get("Content-Type") || "application/json",
			"Cache-Control":
				response.headers.get("Cache-Control") || "no-cache, no-store, must-revalidate",
			...(response.headers.get("Electric-Handle")
				? { "Electric-Handle": response.headers.get("Electric-Handle")! }
				: {}),
			...(response.headers.get("Electric-Offset")
				? { "Electric-Offset": response.headers.get("Electric-Offset")! }
				: {}),
			...(response.headers.get("Electric-Schema")
				? { "Electric-Schema": response.headers.get("Electric-Schema")! }
				: {}),
			...(response.headers.get("Electric-Cursor")
				? { "Electric-Cursor": response.headers.get("Electric-Cursor")! }
				: {}),
		},
	})
}
