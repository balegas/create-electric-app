/**
 * Configure Node's global fetch to use the egress proxy if one is set.
 * Import this at the top of test files that make outbound HTTPS requests.
 *
 * In production, this isn't needed — the service runs in an environment
 * with direct network access. This is only required for the Claude Code
 * sandbox which routes traffic through an egress proxy.
 *
 * Uses EnvHttpProxyAgent so that NO_PROXY / no_proxy is respected
 * (localhost and 127.0.0.1 bypass the proxy for local test servers).
 */

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy

if (proxyUrl) {
	try {
		const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici")
		setGlobalDispatcher(new EnvHttpProxyAgent())
	} catch {
		console.warn(
			"[setup-proxy] undici not available, HTTPS requests may fail behind proxy",
		)
	}
}
