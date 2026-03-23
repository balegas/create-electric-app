import React, { useCallback, useEffect, useRef, useState } from "react"
import { Box, Text, useInput } from "ink"
import type { ElectricAgentClient } from "@electric-agent/protocol/client"
import { Console } from "../components/Console.js"
import { ConsoleEntryView } from "../components/ConsoleEntry.js"
import { PromptInput } from "../components/PromptInput.js"
import { GateOverlay } from "../components/GateOverlay.js"
import { useSessionStream, type ConsoleEntry } from "../hooks/useSessionStream.js"

interface SessionScreenProps {
	client: ElectricAgentClient
	sessionId: string
	projectName?: string
	isActive: boolean
	showGateOverlay: boolean
	browsing: boolean
	onGateOverlayDismiss: () => void
	onGateAppeared: () => void
	onBrowseToggle: () => void
}

export function SessionScreen({
	client,
	sessionId,
	projectName,
	isActive,
	showGateOverlay,
	browsing,
	onGateOverlayDismiss,
	onGateAppeared,
	onBrowseToggle,
}: SessionScreenProps) {
	const { entries, isLive, isComplete, appStatus, markGateResolved } = useSessionStream(client, sessionId)
	const [error, setError] = useState<string | null>(null)
	const [browseIndex, setBrowseIndex] = useState(-1)
	const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())

	// Find unresolved gates
	const unresolvedGateIndex = entries.findIndex((e) => e.kind === "gate" && !e.resolved)
	const unresolvedGateEntry = unresolvedGateIndex >= 0 ? entries[unresolvedGateIndex] : null
	const unresolvedGate = unresolvedGateEntry?.kind === "gate" ? unresolvedGateEntry : null

	// Auto-open the gate overlay when a new gate arrives
	const prevGateRef = useRef<boolean>(false)
	useEffect(() => {
		const hasGate = !!unresolvedGate
		if (hasGate && !prevGateRef.current) {
			onGateAppeared()
		}
		prevGateRef.current = hasGate
	}, [unresolvedGate, onGateAppeared])

	// Filter gate entries out of console — they're handled by the overlay
	const consoleEntries = entries.filter((e) => e.kind !== "gate")

	// When entering browse mode, start at the last entry
	useEffect(() => {
		if (browsing && browseIndex < 0) {
			setBrowseIndex(Math.max(0, consoleEntries.length - 1))
		}
		if (!browsing) {
			setBrowseIndex(-1)
		}
	}, [browsing, consoleEntries.length, browseIndex])

	// Browse mode navigation
	useInput(
		(input, key) => {
			if (key.upArrow) {
				setBrowseIndex((i) => Math.max(0, i - 1))
				return
			}
			if (key.downArrow) {
				setBrowseIndex((i) => Math.min(consoleEntries.length - 1, i + 1))
				return
			}
			// Enter to toggle expand
			if (key.return) {
				setExpandedIds((prev) => {
					const next = new Set(prev)
					if (next.has(browseIndex)) {
						next.delete(browseIndex)
					} else {
						next.add(browseIndex)
					}
					return next
				})
				return
			}
			// Esc to exit browse
			if (key.escape) {
				onBrowseToggle()
				return
			}
		},
		{ isActive: isActive && browsing },
	)

	const handleIterate = useCallback(
		async (message: string) => {
			setError(null)
			try {
				await client.sendIterate(sessionId, message)
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to send message")
			}
		},
		[client, sessionId],
	)

	const handleGateRespond = useCallback(
		async (gate: string, data: Record<string, unknown>) => {
			try {
				await client.respondToGate(sessionId, gate, data)
				if (unresolvedGateIndex >= 0) {
					markGateResolved(unresolvedGateIndex, "Resolved")
				}
				onGateOverlayDismiss()
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to respond to gate")
			}
		},
		[client, sessionId, unresolvedGateIndex, markGateResolved, onGateOverlayDismiss],
	)

	const isRunning = isLive && !isComplete
	const statusText = isComplete ? "complete" : isLive ? "running" : "connecting..."
	const statusColor = isComplete ? "gray" : isLive ? "green" : "yellow"

	return (
		<Box flexDirection="column" flexGrow={1}>
			{/* Header */}
			<Box paddingX={1} justifyContent="space-between">
				<Text bold>{projectName ?? sessionId.slice(0, 8)}</Text>
				<Box gap={2}>
					{appStatus?.previewUrl && (
						<Text color="cyan">App: {appStatus.previewUrl}</Text>
					)}
					{browsing && <Text color="cyan">[browsing]</Text>}
					<Text color={statusColor}>[{statusText}]</Text>
				</Box>
			</Box>

			{/* Gate overlay, browse mode, or console */}
			{showGateOverlay && unresolvedGate ? (
				<GateOverlay
					gate={unresolvedGate}
					onRespond={handleGateRespond}
					onDismiss={onGateOverlayDismiss}
				/>
			) : browsing ? (
				<BrowseConsole
					entries={consoleEntries}
					selectedIndex={browseIndex}
					expandedIds={expandedIds}
				/>
			) : (
				<Console entries={consoleEntries} />
			)}

			{/* Gate alert */}
			{unresolvedGate && !showGateOverlay && (
				<Box paddingX={1}>
					<Text color="yellow" bold>
						{"⚠"} Waiting for your input {"—"} press ^G to respond
					</Text>
				</Box>
			)}

			{/* Browse mode hint */}
			{browsing && (
				<Box paddingX={1}>
					<Text dimColor>{"↑/↓"} navigate  Enter expand  Esc back</Text>
				</Box>
			)}

			{/* Error */}
			{error && (
				<Box paddingX={1}>
					<Text color="red">{error}</Text>
				</Box>
			)}

			{/* Input */}
			<PromptInput
				onSubmit={handleIterate}
				placeholder={isRunning ? "Message..." : "Ask anything..."}
				isActive={isActive && !showGateOverlay && !browsing}
			/>
		</Box>
	)
}

/** Browse console with selection and expansion */
const BrowseConsole = React.memo(function BrowseConsole({
	entries,
	selectedIndex,
	expandedIds,
}: {
	entries: ConsoleEntry[]
	selectedIndex: number
	expandedIds: Set<number>
}) {
	// Show a window of entries around the selected one
	const windowSize = 15
	const half = Math.floor(windowSize / 2)
	const start = Math.max(0, Math.min(selectedIndex - half, entries.length - windowSize))
	const end = Math.min(entries.length, start + windowSize)
	const visible = entries.slice(start, end)

	return (
		<Box flexDirection="column" flexGrow={1} paddingX={1}>
			{start > 0 && (
				<Text dimColor>{"↑"} {start} more above</Text>
			)}
			{visible.map((entry, i) => {
				const realIndex = start + i
				const isSelected = realIndex === selectedIndex
				const isExpanded = expandedIds.has(realIndex)
				return (
					<Box key={realIndex} flexDirection="column">
						<Box>
							<Text color={isSelected ? "cyan" : undefined}>
								{isSelected ? ">" : " "}
							</Text>
							<Box flexGrow={1}>
								<ConsoleEntryView entry={entry} expanded={isExpanded} />
							</Box>
						</Box>
					</Box>
				)
			})}
			{end < entries.length && (
				<Text dimColor>{"↓"} {entries.length - end} more below</Text>
			)}
		</Box>
	)
})
