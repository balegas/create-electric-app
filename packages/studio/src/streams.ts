/**
 * Centralized stream configuration for hosted Durable Streams.
 *
 * Connects to the hosted Durable Streams service (api.electric-sql.cloud)
 * using DS_URL, DS_SERVICE_ID, DS_SECRET environment variables.
 */

export interface StreamConfig {
	/** Base URL of the durable streams service */
	url: string
	/** Service identifier */
	serviceId: string
	/** JWT secret for authorization */
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
 * Returns null if credentials are not configured.
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
 */
export function getStreamConnectionInfo(
	sessionId: string,
	config: StreamConfig,
): StreamConnectionInfo {
	return {
		url: `${config.url}/v1/stream/${config.serviceId}/session/${sessionId}`,
		headers: {
			Authorization: `Bearer ${config.secret}`,
		},
	}
}

/**
 * Build connection info for the registry stream (session + room metadata).
 */
export function getRegistryConnectionInfo(config: StreamConfig): StreamConnectionInfo {
	return {
		url: `${config.url}/v1/stream/${config.serviceId}/registry`,
		headers: {
			Authorization: `Bearer ${config.secret}`,
		},
	}
}

/**
 * Build connection info for a room stream (agent-to-agent messaging).
 */
export function getRoomStreamConnectionInfo(
	roomId: string,
	config: StreamConfig,
): StreamConnectionInfo {
	return {
		url: `${config.url}/v1/stream/${config.serviceId}/room/${roomId}`,
		headers: {
			Authorization: `Bearer ${config.secret}`,
		},
	}
}
