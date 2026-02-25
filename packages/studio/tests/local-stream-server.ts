/**
 * Shared test helper — starts a local Durable Streams server.
 *
 * Usage:
 *   import { localStreamServer } from "./local-stream-server.js"
 *
 *   const server = localStreamServer()
 *   // server.url        — base URL (e.g. "http://127.0.0.1:12345")
 *   // server.config      — StreamConfig-compatible object
 *   // server.connection(sessionId) — StreamConnectionInfo for a session
 *   // server.envVars(sessionId)    — env vars for a sandbox container
 *
 * Call server.start() in a before() hook and server.stop() in after().
 * If env var DS_URL is set, the local server is NOT started and the
 * hosted service is used instead (so CI can test against real infra).
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import type { StreamConfig, StreamConnectionInfo } from "../src/streams.js"

export interface LocalStreamServer {
	/** Start the server (no-op if using hosted) */
	start(): Promise<void>
	/** Stop the server (no-op if using hosted) */
	stop(): Promise<void>
	/** Base URL */
	url: string
	/** StreamConfig-shaped object (works with getStreamConnectionInfo) */
	config: StreamConfig
	/** Build connection info for a session */
	connection(sessionId: string): StreamConnectionInfo
	/** Build env vars for a sandbox */
	envVars(sessionId: string): Record<string, string>
	/** Whether we're using a local server (true) or hosted (false) */
	isLocal: boolean
}

/**
 * Create a local stream server helper.
 * If DS_URL/DS_SERVICE_ID/DS_SECRET are set, uses hosted streams instead.
 */
export function localStreamServer(): LocalStreamServer {
	const hostedUrl = process.env.DS_URL
	const hostedServiceId = process.env.DS_SERVICE_ID
	const hostedSecret = process.env.DS_SECRET

	// If hosted credentials are available, use them
	if (hostedUrl && hostedServiceId && hostedSecret) {
		const config: StreamConfig = {
			url: hostedUrl,
			serviceId: hostedServiceId,
			secret: hostedSecret,
		}
		return {
			isLocal: false,
			url: hostedUrl,
			config,
			async start() {},
			async stop() {},
			connection(sessionId: string): StreamConnectionInfo {
				return {
					url: `${hostedUrl}/v1/stream/${hostedServiceId}/session/${sessionId}`,
					headers: { Authorization: `Bearer ${hostedSecret}` },
				}
			},
			envVars(sessionId: string): Record<string, string> {
				return {
					DS_URL: hostedUrl,
					DS_SERVICE_ID: hostedServiceId,
					DS_SECRET: hostedSecret,
					SESSION_ID: sessionId,
				}
			},
		}
	}

	// Local server mode — no auth needed
	let server: DurableStreamTestServer | null = null
	let serverUrl = ""

	// Local server uses a flat URL scheme: /session/{sessionId}
	// We model this as serviceId="" so the URL becomes {url}/v1/stream//session/{id}
	// But the local server doesn't use the /v1/stream/{serviceId} prefix.
	// Instead we'll construct URLs directly.

	const handle: LocalStreamServer = {
		isLocal: true,
		get url() {
			return serverUrl
		},
		get config(): StreamConfig {
			return {
				url: serverUrl,
				serviceId: "__local__",
				secret: "__local__",
			}
		},
		async start() {
			server = new DurableStreamTestServer({
				port: 0, // auto-assign
				host: "127.0.0.1",
			})
			serverUrl = await server.start()
			console.log(`[test] Local Durable Streams server at ${serverUrl}`)
		},
		async stop() {
			if (server) {
				await server.stop()
				server = null
				console.log("[test] Local Durable Streams server stopped")
			}
		},
		connection(sessionId: string): StreamConnectionInfo {
			// Must match the URL format produced by getStreamConnectionInfo()
			// with config.serviceId="__local__": /v1/stream/__local__/session/{id}
			return {
				url: `${serverUrl}/v1/stream/__local__/session/${sessionId}`,
				headers: {},
			}
		},
		envVars(sessionId: string): Record<string, string> {
			return {
				DS_URL: serverUrl,
				DS_SERVICE_ID: "__local__",
				DS_SECRET: "__local__",
				SESSION_ID: sessionId,
			}
		},
	}

	return handle
}
