import React from "react"
import { Box, Text } from "ink"

interface GateAlertProps {
	message: string
}

export function GateAlert({ message }: GateAlertProps) {
	return (
		<Box paddingX={1}>
			<Text color="yellow" bold>
				{"⚠"} GATE: {message} {"—"} press ^G
			</Text>
		</Box>
	)
}
