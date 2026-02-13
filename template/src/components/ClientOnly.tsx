import type { ReactNode } from "react"
import { useSyncExternalStore } from "react"

const emptySubscribe = () => () => {}

/**
 * Renders children only on the client. During SSR, renders the fallback.
 * Use this to wrap components that use useLiveQuery or collections
 * when they need to be rendered from __root.tsx (which always SSRs).
 *
 * Uses useSyncExternalStore with getServerSnapshot=false so React
 * correctly handles the server/client boundary without hydration mismatch.
 */
export function ClientOnly({
	children,
	fallback,
}: { children: () => ReactNode; fallback?: ReactNode }) {
	const isClient = useSyncExternalStore(
		emptySubscribe,
		() => true,
		() => false,
	)
	return isClient ? children() : (fallback ?? null)
}
