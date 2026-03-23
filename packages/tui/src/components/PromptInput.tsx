import React, { useState } from "react"
import { Box, Text } from "ink"
import { TextInput } from "./TextInput.js"

interface PromptInputProps {
	onSubmit: (value: string) => void
	placeholder?: string
	disabled?: boolean
	isActive?: boolean
}

export function PromptInput({ onSubmit, placeholder = "Type a message...", disabled, isActive = true }: PromptInputProps) {
	const [value, setValue] = useState("")

	const handleSubmit = (text: string) => {
		const trimmed = text.trim()
		if (!trimmed || disabled) return
		onSubmit(trimmed)
		setValue("")
	}

	return (
		<Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingX={1}>
			<Text color="cyan">&gt; </Text>
			{isActive ? (
				<TextInput
					value={value}
					onChange={setValue}
					onSubmit={handleSubmit}
					placeholder={placeholder}
				/>
			) : (
				<Text dimColor>{placeholder}</Text>
			)}
		</Box>
	)
}
