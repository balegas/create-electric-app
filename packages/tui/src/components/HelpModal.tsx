import React from "react"
import { Box, Text } from "ink"

interface HelpModalProps {
	onClose: () => void
}

const SHORTCUTS = [
	["Tab / Shift+Tab", "Switch tabs"],
	["^B / ^F", "Switch tabs (alt)"],
	["^D", "Close tab / delete session"],
	["^S", "Settings"],
	["^G", "Respond to pending gate"],
	["^P", "Peek agent console (rooms)"],
	["^E", "Browse console entries"],
	["^N", "Go to home"],
	["^Q", "Quit"],
	["Esc", "Dismiss / go back"],
	["?", "Toggle this help"],
	["", ""],
	["Enter", "Submit / select"],
	["↑ / ↓", "Navigate lists"],
] as const

export const HelpModal = React.memo(function HelpModal({ onClose }: HelpModalProps) {
	return (
		<Box flexDirection="column" borderStyle="double" paddingX={2} paddingY={1}>
			<Text bold>Keyboard Shortcuts</Text>
			<Box flexDirection="column" marginTop={1}>
				{SHORTCUTS.map(([key, desc], i) =>
					key === "" ? (
						<Text key={i}> </Text>
					) : (
						<Box key={i} gap={2}>
							<Box width={18}>
								<Text color="cyan">{key}</Text>
							</Box>
							<Text>{desc}</Text>
						</Box>
					),
				)}
			</Box>
			<Box marginTop={1}>
				<Text dimColor>Press Esc or ? to close</Text>
			</Box>
		</Box>
	)
})
