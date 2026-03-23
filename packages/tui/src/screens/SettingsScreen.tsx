import React, { useState } from "react"
import { Box, Text, useInput } from "ink"
import { TextInput } from "../components/TextInput.js"
import type { TuiConfig } from "../lib/config.js"
import { maskCredential } from "../lib/formatting.js"

interface SettingsScreenProps {
	config: TuiConfig
	onUpdate: (updates: Partial<TuiConfig>) => void
	isActive: boolean
	connected: boolean
	keychainStatus: "idle" | "loading" | "found" | "not-found" | "error"
}

type Field = "server" | "apiKey" | "githubToken"

const FIELDS: { key: Field; label: string }[] = [
	{ key: "server", label: "Server" },
	{ key: "apiKey", label: "Anthropic Key" },
	{ key: "githubToken", label: "GitHub PAT" },
]

export function SettingsScreen({ config, onUpdate, isActive, connected, keychainStatus }: SettingsScreenProps) {
	const [selectedIndex, setSelectedIndex] = useState(0)
	const [editingField, setEditingField] = useState<Field | null>(null)
	const [editValue, setEditValue] = useState("")

	const getValue = (key: Field): string | undefined => {
		if (key === "server") return config.server
		return config.credentials[key]
	}

	const handleSave = (value: string) => {
		if (!editingField) return
		if (editingField === "server") {
			onUpdate({ server: value })
		} else {
			onUpdate({ credentials: { [editingField]: value || undefined } })
		}
		setEditingField(null)
		setEditValue("")
	}

	// Navigate and edit fields
	useInput(
		(_input, key) => {
			if (editingField) {
				if (key.escape) {
					setEditingField(null)
					setEditValue("")
				}
				return
			}
			if (key.downArrow) {
				setSelectedIndex((i) => Math.min(i + 1, FIELDS.length - 1))
				return
			}
			if (key.upArrow) {
				setSelectedIndex((i) => Math.max(i - 1, 0))
				return
			}
			if (key.return) {
				const field = FIELDS[selectedIndex]
				if (field) {
					setEditingField(field.key)
					setEditValue(getValue(field.key) ?? "")
				}
			}
		},
		{ isActive: isActive && !editingField },
	)

	const authSource = keychainStatus === "found"
		? "keychain"
		: config.credentials.apiKey
			? "api-key"
			: null

	return (
		<Box flexDirection="column" flexGrow={1} paddingX={1}>
			<Box marginY={1} justifyContent="space-between">
				<Text bold>Settings</Text>
				<Text color={connected ? "green" : "red"}>
					[{connected ? "connected" : "disconnected"}]
				</Text>
			</Box>

			{FIELDS.map((field, i) => {
				const value = getValue(field.key)
				const isEditing = editingField === field.key
				const isSelected = i === selectedIndex && !editingField

				const tag = field.key === "apiKey"
					? keychainStatus === "loading"
						? { text: "checking keychain...", color: "yellow" }
						: keychainStatus === "found"
							? { text: "from keychain", color: "green" }
							: authSource === "api-key"
								? { text: "key set", color: "cyan" }
								: null
					: null

				return (
					<Box key={field.key} flexDirection="column" marginBottom={1}>
						<Box>
							<Text inverse={isSelected} bold={isSelected}>
								{isSelected ? "> " : "  "}{field.label}
							</Text>
							{tag && (
								<Text color={tag.color as string}> ({tag.text})</Text>
							)}
						</Box>
						{isEditing ? (
							<Box marginLeft={2}>
								<Text color="cyan">&gt; </Text>
								<TextInput
									value={editValue}
									onChange={setEditValue}
									onSubmit={handleSave}
									isActive={isActive}
								/>
							</Box>
						) : (
							<Box marginLeft={2}>
								<Text dimColor>
									{field.key === "server" ? value : maskCredential(value)}
								</Text>
							</Box>
						)}
					</Box>
				)
			})}

			<Box marginTop={2}>
				<Text dimColor>
					{editingField ? "Enter save  Esc cancel" : "Enter edit  Esc back"}
				</Text>
			</Box>
		</Box>
	)
}
