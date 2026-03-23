import { useInput } from "ink"

export interface KeybindingActions {
	onSwitchTab?: (index: number) => void
	onNewSession?: () => void
	onSettings?: () => void
	onGate?: () => void
	onJoinRoom?: () => void
	onCreateRoom?: () => void
	onPeek?: () => void
	onQuit?: () => void
	onEscape?: () => void
}

export function useKeybindings(actions: KeybindingActions, enabled = true) {
	useInput(
		(input, key) => {
			if (!enabled) return

			// Number keys 1-9 for tab switching
			const num = Number.parseInt(input, 10)
			if (num >= 1 && num <= 9 && !key.ctrl && !key.meta) {
				actions.onSwitchTab?.(num - 1)
				return
			}

			// Letter shortcuts (case-insensitive, no modifiers)
			if (!key.ctrl && !key.meta) {
				switch (input.toLowerCase()) {
					case "n":
						actions.onNewSession?.()
						return
					case "s":
						actions.onSettings?.()
						return
					case "g":
						actions.onGate?.()
						return
					case "j":
						actions.onJoinRoom?.()
						return
					case "r":
						actions.onCreateRoom?.()
						return
					case "p":
						actions.onPeek?.()
						return
					case "q":
						actions.onQuit?.()
						return
				}
			}

			if (key.escape) {
				actions.onEscape?.()
			}
		},
		{ isActive: enabled },
	)
}
