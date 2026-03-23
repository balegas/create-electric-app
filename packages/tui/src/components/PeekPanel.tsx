import React from "react"
import { Box, Text } from "ink"
import type { ConsoleEntry } from "../hooks/useSessionStream.js"
import { ConsoleEntryView } from "./ConsoleEntry.js"

interface PeekPanelProps {
	agentName: string
	entries: ConsoleEntry[]
	maxLines?: number
}

export function PeekPanel({ agentName, entries, maxLines = 8 }: PeekPanelProps) {
	const visible = entries.slice(-maxLines)

	return (
		<Box
			flexDirection="column"
			borderStyle="single"
			paddingX={1}
			marginX={1}
		>
			<Box justifyContent="space-between">
				<Text bold>Peek: {agentName}</Text>
				<Text dimColor>[Esc close]</Text>
			</Box>
			{visible.length === 0 ? (
				<Text dimColor>No events yet...</Text>
			) : (
				visible.map((entry, i) => (
					<ConsoleEntryView key={i} entry={entry} />
				))
			)}
		</Box>
	)
}
