/**
 * Gate management for orchestrator <-> web UI communication.
 *
 * When the orchestrator hits a decision point (plan approval, clarification, continue),
 * it pauses on a Promise. The web UI resolves that Promise by POSTing to the API.
 */

interface PendingGate<T = unknown> {
	resolve: (value: T) => void
	reject: (reason: Error) => void
}

const gates = new Map<string, PendingGate>()

function gateKey(sessionId: string, gate: string): string {
	return `${sessionId}:${gate}`
}

/**
 * Create a gate that blocks until resolved via resolveGate().
 */
export function createGate<T>(sessionId: string, gate: string): Promise<T> {
	const key = gateKey(sessionId, gate)
	console.log(
		`[gate] creating gate key=${key} (existing gates: ${[...gates.keys()].join(", ") || "none"})`,
	)
	return new Promise<T>((resolve, reject) => {
		gates.set(key, {
			resolve: resolve as (value: unknown) => void,
			reject,
		})
		console.log(`[gate] gate registered key=${key}`)
	})
}

/**
 * Resolve a pending gate with a value.
 * Returns true if a gate was found and resolved, false otherwise.
 */
export function resolveGate(sessionId: string, gate: string, value: unknown): boolean {
	const key = gateKey(sessionId, gate)
	console.log(
		`[gate] resolving key=${key} (existing gates: ${[...gates.keys()].join(", ") || "none"})`,
	)
	const pending = gates.get(key)
	if (pending) {
		pending.resolve(value)
		gates.delete(key)
		console.log(`[gate] resolved key=${key}`)
		return true
	}
	console.log(`[gate] NOT FOUND key=${key}`)
	return false
}

/**
 * Reject a pending gate (e.g., on session cancellation).
 */
export function rejectGate(sessionId: string, gate: string, reason: string): boolean {
	const key = gateKey(sessionId, gate)
	const pending = gates.get(key)
	if (pending) {
		pending.reject(new Error(reason))
		gates.delete(key)
		return true
	}
	return false
}

/**
 * Check if a gate is pending.
 */
export function hasGate(sessionId: string, gate: string): boolean {
	return gates.has(gateKey(sessionId, gate))
}

/**
 * Reject all gates for a session (cleanup on cancel/error).
 */
export function rejectAllGates(sessionId: string): void {
	for (const [key, pending] of gates) {
		if (key.startsWith(`${sessionId}:`)) {
			pending.reject(new Error("Session cancelled"))
			gates.delete(key)
		}
	}
}
