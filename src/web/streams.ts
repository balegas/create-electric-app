/**
 * Centralized stream configuration for Durable Streams.
 *
 * Supports two modes:
 * - **Hosted**: Connects to the hosted Durable Streams service (api.electric-sql.cloud)
 *   using DS_URL, DS_SERVICE_ID, DS_SECRET environment variables.
 * - **Local**: Falls back to a local DurableStreamTestServer for development.
 */

export interface StreamConfig {
	/** Base URL of the durable streams service */
	url: string
	/** Service identifier (hosted mode only) */
	serviceId: string
	/** JWT secret for authorization (hosted mode only) */
	secret: string
}

export interface StreamConnectionInfo {
	/** Full URL to a specific session stream */
	url: string
	/** Headers to include with every request */
	headers: Record<string, string>
}

/**
 * Read stream config from environment variables.
 * Returns null if hosted stream credentials are not configured.
 */
export function getStreamConfig(): StreamConfig | null {
	const url = process.env.DS_URL
	const serviceId = process.env.DS_SERVICE_ID
	const secret = process.env.DS_SECRET

	if (!url || !serviceId || !secret) {
		return null
	}

	return { url, serviceId, secret }
}

/**
 * Build connection info for a specific session stream.
 *
 * For hosted mode: constructs the full URL with service ID path and auth headers.
 * For local mode: constructs a simple localhost URL with no auth.
 */
export function getStreamConnectionInfo(
	sessionId: string,
	config?: StreamConfig | null,
	localPort?: number,
): StreamConnectionInfo {
	if (config) {
		return {
			url: `${config.url}/v1/stream/${config.serviceId}/session/${sessionId}`,
			headers: {
				Authorization: `Bearer ${config.secret}`,
			},
		}
	}

	// Fallback to local DurableStreamTestServer
	return {
		url: `http://127.0.0.1:${localPort ?? 4437}/session/${sessionId}`,
		headers: {},
	}
}

/**
 * Check if hosted stream credentials are configured.
 */
export function isHostedStreams(): boolean {
	return getStreamConfig() !== null
}

/**
 * Env vars to pass to a sandbox so it can connect to the same stream.
 */
export function getStreamEnvVars(
	sessionId: string,
	config?: StreamConfig | null,
	localPort?: number,
): Record<string, string> {
	if (config) {
		return {
			DS_URL: config.url,
			DS_SERVICE_ID: config.serviceId,
			DS_SECRET: config.secret,
			SESSION_ID: sessionId,
			STREAM_MODE: "hosted",
		}
	}

	return {
		SESSION_ID: sessionId,
		STREAM_MODE: "local",
		DS_LOCAL_PORT: String(localPort ?? 4437),
	}
}
