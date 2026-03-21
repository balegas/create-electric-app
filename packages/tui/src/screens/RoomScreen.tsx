import React, { useCallback, useEffect, useRef, useState } from "react"
import { Box, Text, useInput } from "ink"
import SelectInput from "ink-select-input"
import type { ElectricAgentClient, RoomState } from "@electric-agent/protocol/client"
import type { RoomEvent } from "@electric-agent/protocol"
import { useRoomStream } from "../hooks/useRoomStream.js"
import { useSessionStream } from "../hooks/useSessionStream.js"
import { Console } from "../components/Console.js"
import { PromptInput } from "../components/PromptInput.js"
import { ParticipantBar } from "../components/ParticipantBar.js"
import { GateOverlay } from "../components/GateOverlay.js"

interface RoomScreenProps {
	client: ElectricAgentClient
	roomId: string
	roomName?: string
	participantName: string
	isActive: boolean
	showPeek: boolean
	onPeekDismiss: () => void
	gateRequested: boolean
	onGateDismissed: () => void
}

type View = "room" | "selecting-agent" | "agent"

export function RoomScreen({
	client,
	roomId,
	roomName,
	participantName,
	isActive,
	showPeek,
	onPeekDismiss,
	gateRequested,
	onGateDismissed,
}: RoomScreenProps) {
	const { events, messages, isLive, isClosed } = useRoomStream(client, roomId)
	const [roomState, setRoomState] = useState<RoomState | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [view, setView] = useState<View>("room")
	const [peekAgent, setPeekAgent] = useState<{ sessionId: string; name: string } | null>(null)
	const [showInfraGate, setShowInfraGate] = useState(false)
	const [infraGateResolved, setInfraGateResolved] = useState(false)
	const [agentHasGate, setAgentHasGate] = useState(false)

	// Fetch room state periodically
	useEffect(() => {
		let cancelled = false
		async function fetchState() {
			try {
				const state = await client.getAgentRoomState(roomId)
				if (!cancelled) {
					setRoomState(state)
					if (state.pendingInfraGate && !infraGateResolved) {
						setShowInfraGate(true)
					}
				}
			} catch { /* ignore */ }
		}
		fetchState()
		const interval = setInterval(fetchState, 5000)
		return () => { cancelled = true; clearInterval(interval) }
	}, [client, roomId, infraGateResolved])

	// ^P from parent → open agent selector
	useEffect(() => {
		if (showPeek && view === "room") {
			setView("selecting-agent")
		}
	}, [showPeek, view])

	// ^G from parent → open infra gate
	useEffect(() => {
		if (gateRequested && roomState?.pendingInfraGate && !infraGateResolved) {
			setShowInfraGate(true)
		}
	}, [gateRequested, roomState?.pendingInfraGate, infraGateResolved])

	// Escape from agent view or selector → back to room
	useInput(
		(_input, key) => {
			if (key.escape) {
				if (view === "agent" || view === "selecting-agent") {
					setView("room")
					setPeekAgent(null)
					setAgentHasGate(false)
					onPeekDismiss()
				}
			}
		},
		{ isActive: isActive && view !== "room" },
	)

	const handleSend = useCallback(
		async (message: string) => {
			setError(null)
			try {
				await client.sendRoomMessage(roomId, participantName, message)
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to send message")
			}
		},
		[client, roomId, participantName],
	)

	const handleInfraGateRespond = useCallback(
		async (gate: string, data: Record<string, unknown>) => {
			if (!roomState?.pendingInfraGate) return
			try {
				await client.respondToGate(roomState.pendingInfraGate.sessionId, gate, data)
				setInfraGateResolved(true)
				setShowInfraGate(false)
				onGateDismissed()
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to respond to gate")
			}
		},
		[client, roomState?.pendingInfraGate, onGateDismissed],
	)

	const participants = roomState?.participants ?? []
	const workingAgents = participants.filter((p) => p.running && !p.needsInput)
	const pendingInfraGate = roomState?.pendingInfraGate && !infraGateResolved
	const statusText = isClosed ? "closed" : isLive ? "active" : "connecting..."
	const statusColor = isClosed ? "gray" : isLive ? "cyan" : "yellow"

	return (
		<Box flexDirection="column" flexGrow={1}>
			{/* Header */}
			<Box paddingX={1} justifyContent="space-between">
				<Box gap={2}>
					<Text bold>Room: {roomName ?? roomId.slice(0, 8)}</Text>
					{view === "agent" && peekAgent && (
						<Text color="cyan">{"→"} {peekAgent.name} (Esc back)</Text>
					)}
				</Box>
				<Box gap={2}>
					{roomState?.previewUrl && (
						<Text color="cyan">App: {roomState.previewUrl}</Text>
					)}
					<Text color={statusColor}>[{statusText}]</Text>
				</Box>
			</Box>

			{/* Participants */}
			{participants.length > 0 && (
				<ParticipantBar participants={participants} />
			)}

			{/* Main content area */}
			{showInfraGate && pendingInfraGate && roomState?.pendingInfraGate ? (
				<GateOverlay
					gate={{
						kind: "gate",
						event: {
							type: "infra_config_prompt" as const,
							projectName: roomState.pendingInfraGate.projectName,
							ghAccounts: [],
							runtime: roomState.pendingInfraGate.runtime as "docker" | "sprites",
							ts: new Date().toISOString(),
						},
						resolved: false,
						ts: new Date().toISOString(),
					}}
					onRespond={handleInfraGateRespond}
					onDismiss={() => { setShowInfraGate(false); onGateDismissed() }}
				/>
			) : view === "selecting-agent" ? (
				<Box flexDirection="column" borderStyle="double" paddingX={2} paddingY={1} marginX={1}>
					<Text bold>Select agent to view:</Text>
					<Box marginTop={1}>
						<SelectInput
							items={participants.map((p) => ({
								label: `${p.name}${p.role ? ` (${p.role})` : ""} ${p.running ? "[running]" : "[done]"}`,
								value: p.sessionId,
							}))}
							onSelect={(item) => {
								const p = participants.find((pp) => pp.sessionId === item.value)
								if (p) {
									setPeekAgent({ sessionId: p.sessionId, name: p.name })
									setView("agent")
								}
							}}
						/>
					</Box>
				</Box>
			) : view === "agent" && peekAgent ? (
				<>
					<AgentConsoleView client={client} sessionId={peekAgent.sessionId} onGateAppeared={() => setAgentHasGate(true)} />
					{agentHasGate && (
						<Box paddingX={1}>
							<Text color="yellow" bold>
								{"\u26A0"} Agent has a pending gate {"\u2014"} press ^G to respond
							</Text>
						</Box>
					)}
				</>
			) : (
				<>
					<Box flexDirection="column" flexGrow={1} paddingX={1}>
						{events.length === 0 ? (
							<Text dimColor>
								{participants.length === 0 ? "Setting up agents..." : "Waiting for messages..."}
							</Text>
						) : (
							events.slice(-30).map((event, i) => (
								<RoomEventEntry key={i} event={event} participants={participants} />
							))
						)}
						{workingAgents.length > 0 && (
							<Box>
								<Text color="yellow">
									{"⏳"} {workingAgents.map((a) => a.name).join(", ")}{" "}
									{workingAgents.length === 1 ? "is" : "are"} working
								</Text>
							</Box>
						)}
					</Box>
					{pendingInfraGate && !showInfraGate && (
						<Box paddingX={1}>
							<Text color="yellow" bold>
								{"⚠"} Waiting for infrastructure config {"—"} press ^G
							</Text>
						</Box>
					)}
				</>
			)}

			{/* Error */}
			{error && (
				<Box paddingX={1}>
					<Text color="red">{error}</Text>
				</Box>
			)}

			{/* Input */}
			<PromptInput
				onSubmit={handleSend}
				placeholder="Send to room..."
				isActive={isActive && view === "room" && !showInfraGate}
			/>
		</Box>
	)
}

/** Full agent console view (not a small peek panel) */
function AgentConsoleView({
	client,
	sessionId,
	onGateAppeared,
}: {
	client: ElectricAgentClient
	sessionId: string
	onGateAppeared?: () => void
}) {
	const { entries, isLive, error } = useSessionStream(client, sessionId)
	const consoleEntries = entries.filter((e) => e.kind !== "gate")
	const hasUnresolvedGate = entries.some((e) => e.kind === "gate" && !e.resolved)
	const notifiedRef = useRef(false)

	useEffect(() => {
		if (hasUnresolvedGate && !notifiedRef.current && onGateAppeared) {
			notifiedRef.current = true
			onGateAppeared()
		}
		if (!hasUnresolvedGate) {
			notifiedRef.current = false
		}
	}, [hasUnresolvedGate, onGateAppeared])

	if (error) {
		return (
			<Box flexDirection="column" flexGrow={1} paddingX={1}>
				<Text color="red">Failed to connect to agent stream: {error}</Text>
			</Box>
		)
	}

	if (!isLive && consoleEntries.length === 0) {
		return (
			<Box flexDirection="column" flexGrow={1} paddingX={1}>
				<Text dimColor>Connecting to agent stream...</Text>
			</Box>
		)
	}

	return (
		<Box flexDirection="column" flexGrow={1}>
			<Console entries={consoleEntries} />
		</Box>
	)
}

/** Render a single room event */
function RoomEventEntry({ event, participants }: { event: RoomEvent; participants: RoomState["participants"] }) {
	switch (event.type) {
		case "agent_message":
			return (
				<Box flexDirection="column">
					<Box>
						<Text color="cyan" bold>[{event.from}]</Text>
						{event.to && (
							<Text dimColor> {"\u2192"} [{event.to}]</Text>
						)}
					</Box>
					<Box marginLeft={2}>
						<Text wrap="wrap">{event.body}</Text>
					</Box>
				</Box>
			)
		case "participant_joined": {
			const p = participants.find((pp) => pp.name === event.participant?.displayName)
			const roleLabel = p?.role ? ` (${p.role})` : ""
			return (
				<Box>
					<Text color="blue">[system]</Text>
					<Text> {event.participant?.displayName ?? "Unknown"}{roleLabel} joined</Text>
				</Box>
			)
		}
		case "participant_left":
			return (
				<Box>
					<Text color="blue">[system]</Text>
					<Text> Participant left</Text>
				</Box>
			)
		case "room_closed":
			return (
				<Box>
					<Text color="blue">[system]</Text>
					<Text> Room closed by {event.closedBy}{event.summary ? ` — ${event.summary}` : ""}</Text>
				</Box>
			)
		case "room_created":
			return (
				<Box>
					<Text color="blue">[system]</Text>
					<Text> Room created: {event.name}</Text>
				</Box>
			)
		default:
			return null
	}
}
