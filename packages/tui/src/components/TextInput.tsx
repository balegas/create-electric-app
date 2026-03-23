import React, { useState } from "react"
import { Text, useInput } from "ink"

interface TextInputProps {
	value: string
	onChange: (value: string) => void
	onSubmit?: (value: string) => void
	placeholder?: string
	isActive?: boolean
}

/**
 * Custom TextInput with readline-style shortcuts.
 *
 * IMPORTANT: Ink v5 maps the physical Backspace key (0x7F) to `key.delete`,
 * NOT `key.backspace`. On virtually all modern terminals, Backspace sends 0x7F.
 * Ink maps 0x08 (Ctrl+H) to `key.backspace` and 0x7F to `key.delete`.
 * So we must check BOTH `key.backspace || key.delete` for backspace behavior.
 */
export function TextInput({
	value,
	onChange,
	onSubmit,
	placeholder,
	isActive = true,
}: TextInputProps) {
	const [cursor, setCursor] = useState(value.length)

	// Clamp cursor if value changed externally
	const clampedCursor = Math.min(cursor, value.length)
	if (clampedCursor !== cursor) {
		setCursor(clampedCursor)
	}

	useInput(
		(input, key) => {
			const c = clampedCursor

			// Submit
			if (key.return) {
				onSubmit?.(value)
				return
			}

			// Ctrl+A — move to start
			if (key.ctrl && input === "a") {
				setCursor(0)
				return
			}

			// Ctrl+E — move to end
			if (key.ctrl && input === "e") {
				setCursor(value.length)
				return
			}

			// Ctrl+U — delete to start of line
			if (key.ctrl && input === "u") {
				onChange(value.slice(c))
				setCursor(0)
				return
			}

			// Ctrl+K — delete to end of line
			if (key.ctrl && input === "k") {
				onChange(value.slice(0, c))
				return
			}

			// Ctrl+W — delete word backward
			if (key.ctrl && input === "w") {
				const boundary = findWordBoundaryLeft(value, c)
				onChange(value.slice(0, boundary) + value.slice(c))
				setCursor(boundary)
				return
			}

			// Option/Meta + Backspace/Delete — delete word backward
			// (Ink maps physical Backspace to key.delete, so check both)
			if (key.meta && (key.backspace || key.delete)) {
				const boundary = findWordBoundaryLeft(value, c)
				onChange(value.slice(0, boundary) + value.slice(c))
				setCursor(boundary)
				return
			}

			// Backspace — delete character backward
			// Physical Backspace sends 0x7F which Ink maps to key.delete.
			// key.backspace is 0x08 (Ctrl+H). Check both.
			if (key.backspace || key.delete) {
				if (c > 0) {
					onChange(value.slice(0, c - 1) + value.slice(c))
					setCursor(c - 1)
				}
				return
			}

			// Left arrow
			if (key.leftArrow) {
				if (key.meta) {
					// Option+Left — move word left
					setCursor(findWordBoundaryLeft(value, c))
				} else {
					setCursor(Math.max(0, c - 1))
				}
				return
			}

			// Right arrow
			if (key.rightArrow) {
				if (key.meta) {
					// Option+Right — move word right
					setCursor(findWordBoundaryRight(value, c))
				} else {
					setCursor(Math.min(value.length, c + 1))
				}
				return
			}

			// Tab — ignore (let parent handle)
			if (key.tab) {
				return
			}

			// Ignore other control sequences
			if (key.ctrl || key.meta || key.escape) {
				return
			}

			// Regular character input
			if (input) {
				onChange(value.slice(0, c) + input + value.slice(c))
				setCursor(c + input.length)
			}
		},
		{ isActive },
	)

	// Show text with cursor
	if (!isActive) {
		return <Text dimColor>{value || ""}</Text>
	}

	const c = clampedCursor
	const before = value.slice(0, c)
	const cursorChar = value[c] ?? " "
	const after = value.slice(c + 1)

	return (
		<Text>
			{before}
			<Text inverse>{cursorChar}</Text>
			{after}
		</Text>
	)
}

function findWordBoundaryLeft(text: string, pos: number): number {
	if (pos === 0) return 0
	let i = pos - 1
	// Skip whitespace
	while (i > 0 && /\s/.test(text[i]!)) i--
	// Skip word characters
	while (i > 0 && !/\s/.test(text[i - 1]!)) i--
	return i
}

function findWordBoundaryRight(text: string, pos: number): number {
	if (pos >= text.length) return text.length
	let i = pos
	// Skip word characters
	while (i < text.length && !/\s/.test(text[i]!)) i++
	// Skip whitespace
	while (i < text.length && /\s/.test(text[i]!)) i++
	return i
}
