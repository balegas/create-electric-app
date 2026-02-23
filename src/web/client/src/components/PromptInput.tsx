import { useCallback, useRef, useState } from "react"
import { useEscapeKey } from "../hooks/useKeyboardShortcut"

interface PromptInputProps {
	onSubmit: (text: string) => void
	placeholder?: string
	disabled?: boolean
	isRunning?: boolean
	onCancel?: () => void
}

export function PromptInput({
	onSubmit,
	placeholder,
	disabled,
	isRunning,
	onCancel,
}: PromptInputProps) {
	const [value, setValue] = useState("")
	const textareaRef = useRef<HTMLTextAreaElement>(null)

	const handleSubmit = useCallback(() => {
		const trimmed = value.trim()
		if (!trimmed) return
		onSubmit(trimmed)
		setValue("")
		// Reset textarea height
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto"
		}
	}, [value, onSubmit])

	const handleCancel = useCallback(() => {
		if (isRunning && onCancel) onCancel()
	}, [isRunning, onCancel])

	useEscapeKey(handleCancel, !isRunning)

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault()
				handleSubmit()
			}
		},
		[handleSubmit],
	)

	// Auto-resize textarea
	const handleInput = useCallback(() => {
		const ta = textareaRef.current
		if (ta) {
			ta.style.height = "auto"
			ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
		}
	}, [])

	return (
		<div className="prompt-bar">
			<textarea
				ref={textareaRef}
				value={value}
				onChange={(e) => {
					setValue(e.target.value)
					handleInput()
				}}
				onKeyDown={handleKeyDown}
				placeholder={placeholder ?? "Describe what you want to build..."}
				disabled={disabled}
				rows={1}
			/>
			<button className="primary" onClick={handleSubmit} disabled={disabled || !value.trim()}>
				Send
			</button>
			{isRunning && onCancel && (
				<button className="danger" onClick={onCancel}>
					Stop
				</button>
			)}
		</div>
	)
}
