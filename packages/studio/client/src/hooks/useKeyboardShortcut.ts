import { useEffect } from "react"

/**
 * Registers a global keyboard shortcut that fires a callback.
 * Ignores events when the user is typing in an input/textarea/select
 * unless `allowInInputs` is true.
 */
export function useKeyboardShortcut(
	key: string,
	callback: () => void,
	opts?: { disabled?: boolean; allowInInputs?: boolean },
) {
	useEffect(() => {
		if (opts?.disabled) return

		function handler(e: KeyboardEvent) {
			// Don't fire shortcuts while typing in form fields (unless explicitly allowed)
			if (!opts?.allowInInputs) {
				const tag = (e.target as HTMLElement)?.tagName
				if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
			}

			if (e.key === key) {
				e.preventDefault()
				callback()
			}
		}

		window.addEventListener("keydown", handler)
		return () => window.removeEventListener("keydown", handler)
	}, [key, callback, opts?.disabled, opts?.allowInInputs])
}

/**
 * Registers an Escape key handler — always works, even in inputs.
 */
export function useEscapeKey(callback: () => void, disabled?: boolean) {
	useEffect(() => {
		if (disabled) return

		function handler(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.preventDefault()
				callback()
			}
		}

		window.addEventListener("keydown", handler)
		return () => window.removeEventListener("keydown", handler)
	}, [callback, disabled])
}
