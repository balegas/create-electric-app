import React from "react"
import { Box, Static, Text } from "ink"
import type { ConsoleEntry } from "../hooks/useSessionStream.js"
import { ConsoleEntryView } from "./ConsoleEntry.js"

interface ConsoleProps {
	entries: ConsoleEntry[]
}

/**
 * Console uses Ink's <Static> for entries that are finalized (won't change).
 * Static items are rendered once and never erased/redrawn, eliminating flicker.
 * Only the last few "live" entries are in the dynamic portion.
 */
export const Console = React.memo(function Console({ entries }: ConsoleProps) {
	// Entries that are "done" — logs, resolved gates, completed tool calls
	// The last entry might still be in-progress, keep it dynamic
	const staticCount = Math.max(0, entries.length - 5)
	const staticEntries = entries.slice(0, staticCount)
	const dynamicEntries = entries.slice(staticCount)

	return (
		<Box flexDirection="column" flexGrow={1} paddingX={1}>
			{staticEntries.length > 0 && (
				<Static items={staticEntries}>
					{(entry, i) => (
						<Box key={`s-${i}`}>
							<ConsoleEntryView entry={entry} />
						</Box>
					)}
				</Static>
			)}
			{dynamicEntries.length === 0 && staticEntries.length === 0 && (
				<Text dimColor>Waiting for events...</Text>
			)}
			{dynamicEntries.map((entry, i) => (
				<ConsoleEntryView key={`d-${staticCount + i}`} entry={entry} />
			))}
		</Box>
	)
})
