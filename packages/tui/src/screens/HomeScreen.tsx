import React, { useState } from "react"
import { Box, Text, useInput } from "ink"
import { TextInput } from "../components/TextInput.js"
import type { SessionInfo } from "@electric-agent/protocol/client"

interface HomeScreenProps {
	sessions: SessionInfo[]
	deletingIds: Set<string>
	onCreateSession: (description: string) => void
	onCreateRoom: (description: string) => void
	onJoinRoom: (code: string) => void
	onSelectSession: (id: string) => void
	onDeleteSession: (id: string) => void
	isActive: boolean
	inputDisabled?: boolean
}

type Mode = "prompt" | "browse" | "join"

export function HomeScreen({
	sessions,
	deletingIds,
	onCreateSession,
	onCreateRoom,
	onJoinRoom,
	onSelectSession,
	onDeleteSession,
	isActive,
	inputDisabled,
}: HomeScreenProps) {
	const [input, setInput] = useState("")
	const [mode, setMode] = useState<Mode>("prompt")
	const [joinCode, setJoinCode] = useState("")
	const [browseIndex, setBrowseIndex] = useState(0)
	const [freeform, setFreeform] = useState(false)

	const recentSessions = sessions
		.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
		.slice(0, 10)

	const handleSubmit = (value: string) => {
		const trimmed = value.trim()
		if (!trimmed) {
			if (recentSessions.length > 0) {
				setMode("browse")
				setBrowseIndex(0)
			}
			return
		}
		if (freeform) {
			onCreateSession(trimmed)
		} else {
			onCreateRoom(trimmed)
		}
		setInput("")
	}

	const handleJoinSubmit = (value: string) => {
		const trimmed = value.trim()
		if (!trimmed) return
		onJoinRoom(trimmed)
		setJoinCode("")
		setMode("prompt")
	}

	// Down arrow from prompt → enter browse mode
	// Ctrl+T → toggle freeform mode, Ctrl+J → switch to join mode
	useInput(
		(input, key) => {
			if (key.downArrow && recentSessions.length > 0) {
				setMode("browse")
				setBrowseIndex(0)
				return
			}
			if (key.ctrl && input === "t") {
				setFreeform((v) => !v)
				return
			}
			if (key.ctrl && input === "j") {
				setMode("join")
				return
			}
		},
		{ isActive: isActive && mode === "prompt" && !inputDisabled },
	)

	// Browse mode navigation
	useInput(
		(input, key) => {
			if (key.downArrow) {
				setBrowseIndex((i) => Math.min(i + 1, recentSessions.length - 1))
				return
			}
			if (key.upArrow) {
				if (browseIndex === 0) {
					setMode("prompt")
				} else {
					setBrowseIndex((i) => i - 1)
				}
				return
			}
			if (key.return) {
				const session = recentSessions[browseIndex]
				if (session) onSelectSession(session.id)
				return
			}
			// Ctrl+D to delete
			if (key.ctrl && input === "d") {
				const session = recentSessions[browseIndex]
				if (session) {
					onDeleteSession(session.id)
					setBrowseIndex((i) => Math.min(i, recentSessions.length - 2))
					if (recentSessions.length <= 1) {
						setMode("prompt")
					}
				}
				return
			}
			if (key.escape) {
				setMode("prompt")
				return
			}
		},
		{ isActive: isActive && mode === "browse" && !inputDisabled },
	)

	// Join mode escape
	useInput(
		(_input, key) => {
			if (key.escape) setMode("prompt")
		},
		{ isActive: isActive && mode === "join" && !inputDisabled },
	)

	return (
		<Box flexDirection="column" flexGrow={1} paddingX={1}>
			<Box flexDirection="column" marginY={1}>
				<Text bold color="yellow">
					{"⚡"} Electric App Studio
				</Text>
			</Box>

			{mode === "join" ? (
				<Box flexDirection="column">
					<Text>Enter room invite code:</Text>
					<Box marginTop={1}>
						<Text color="cyan">&gt; </Text>
						<TextInput
							value={joinCode}
							onChange={setJoinCode}
							onSubmit={handleJoinSubmit}
							placeholder="room-id/code"
							isActive={isActive && !inputDisabled}
						/>
					</Box>
					<Text dimColor>[Esc] back</Text>
				</Box>
			) : (
				<Box flexDirection="column">
					<Text>
						{freeform
							? "Describe what you want (freeform session):"
							: "Describe the app you want to build:"}
					</Text>
					<Box marginTop={1}>
						<Text color="cyan">&gt; </Text>
						<TextInput
							value={input}
							onChange={setInput}
							onSubmit={handleSubmit}
							placeholder="A todo app with real-time sync..."
							isActive={isActive && mode === "prompt" && !inputDisabled}
						/>
					</Box>
					<Box marginTop={1} gap={2}>
						<Text dimColor>
							Mode: {freeform ? "freeform" : "room"} [^T toggle]
						</Text>
						<Text dimColor>[^J join room]</Text>
					</Box>
				</Box>
			)}

			{recentSessions.length > 0 && (
				<Box flexDirection="column" marginTop={2}>
					<Text bold>Recent:</Text>
					{recentSessions.map((session, i) => {
						const timeAgo = formatTimeAgo(session.lastActiveAt)
						const isSelected = mode === "browse" && i === browseIndex
						const isDeleting = deletingIds.has(session.id)
						const sColor = isDeleting ? "gray" : statusColor(session.status)

						return (
							<Box key={session.id} gap={1}>
								<Text color={isSelected ? "cyan" : undefined}>
									{isSelected ? ">" : " "}
								</Text>
								<Text inverse={isSelected} color={isSelected ? undefined : sColor} strikethrough={isDeleting}>
									{statusIcon(session.status)}
								</Text>
								<Text inverse={isSelected} bold={isSelected} dimColor={isDeleting} strikethrough={isDeleting}>
									{session.projectName || session.description?.slice(0, 40) || session.id.slice(0, 8)}
								</Text>
								<Text inverse={isSelected} dimColor>{timeAgo}</Text>
								<Text color={sColor}>
									{isDeleting ? "[deleting...]" : `[${session.status}]`}
								</Text>
							</Box>
						)
					})}
				</Box>
			)}
		</Box>
	)
}

function statusIcon(status: string): string {
	if (status === "running") return "\u25cf"
	if (status === "complete") return "\u25cb"
	return "\u25b2"
}

function statusColor(status: string): string {
	if (status === "running") return "green"
	if (status === "complete") return "gray"
	if (status === "error") return "red"
	return "yellow"
}

function formatTimeAgo(dateStr: string): string {
	const diff = Date.now() - new Date(dateStr).getTime()
	const minutes = Math.floor(diff / 60000)
	if (minutes < 1) return "just now"
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.floor(hours / 24)
	return `${days}d ago`
}
