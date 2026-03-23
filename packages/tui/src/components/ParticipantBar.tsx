import React from "react"
import { Box, Text } from "ink"

export interface Participant {
	sessionId: string
	name: string
	role?: string
	running?: boolean
	needsInput?: boolean
}

interface ParticipantBarProps {
	participants: Participant[]
}

export function ParticipantBar({ participants }: ParticipantBarProps) {
	return (
		<Box paddingX={1} gap={2}>
			<Text dimColor>Participants:</Text>
			{participants.map((p) => {
				let statusColor = "gray"
				let statusIcon = "\u25cb" // empty circle
				if (p.running) {
					statusColor = "green"
					statusIcon = "\u25cf" // filled circle
				}
				if (p.needsInput) {
					statusColor = "yellow"
					statusIcon = "!"
				}

				return (
					<Box key={p.sessionId}>
						<Text color={statusColor}>
							{p.name}
							{p.role ? ` (${p.role})` : ""}
							{" "}[{statusIcon}]
						</Text>
					</Box>
				)
			})}
		</Box>
	)
}
