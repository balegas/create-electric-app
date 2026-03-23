import React, { useState } from "react"
import { Box, Text } from "ink"
import SelectInput from "ink-select-input"
import { TextInput } from "./TextInput.js"
import type { ConsoleEntry } from "../hooks/useSessionStream.js"
import type { EngineEvent } from "@electric-agent/protocol"

interface GateOverlayProps {
	gate: ConsoleEntry & { kind: "gate" }
	onRespond: (gate: string, data: Record<string, unknown>) => void
	onDismiss: () => void
}

export function GateOverlay({ gate, onRespond, onDismiss }: GateOverlayProps) {
	const event = gate.event

	if (event.type === "infra_config_prompt") {
		return <InfraConfigGate event={event} onRespond={onRespond} onDismiss={onDismiss} />
	}

	if (event.type === "ask_user_question") {
		return <UserQuestionGate event={event} onRespond={onRespond} onDismiss={onDismiss} />
	}

	if (event.type === "outbound_message_gate") {
		return <OutboundMessageGate event={event} onRespond={onRespond} onDismiss={onDismiss} />
	}

	return null
}

function InfraConfigGate({
	event,
	onRespond,
	onDismiss,
}: {
	event: Extract<EngineEvent, { type: "infra_config_prompt" }>
	onRespond: (gate: string, data: Record<string, unknown>) => void
	onDismiss: () => void
}) {
	const [step, setStep] = useState<"infra" | "github">("infra")
	const [infraMode, setInfraMode] = useState<string>("")

	const infraItems = [
		...(event.runtime === "docker" ? [{ label: "Local Docker", value: "local" }] : []),
		{ label: "Provision Electric Cloud (72h trial)", value: "provision" },
		{ label: "Bring your own (provide URLs)", value: "byo" },
	]

	const ghItems = [
		...event.ghAccounts.map((a) => ({
			label: `${a.login} (${a.type})`,
			value: a.login,
		})),
		{ label: "Skip repository creation", value: "__skip__" },
	]

	if (step === "infra") {
		return (
			<Box flexDirection="column" borderStyle="double" paddingX={2} paddingY={1}>
				<Text bold color="yellow">Infrastructure Configuration</Text>
				<Text dimColor>Project: {event.projectName}</Text>
				<Box marginTop={1}>
					<Text>How should the app be hosted?</Text>
				</Box>
				<Box marginTop={1}>
					<SelectInput
						items={infraItems}
						onSelect={(item) => {
							setInfraMode(item.value)
							if (ghItems.length > 1) {
								setStep("github")
							} else {
								onRespond("infra_config", { mode: item.value })
							}
						}}
					/>
				</Box>
				<Text dimColor>Esc dismiss</Text>
			</Box>
		)
	}

	return (
		<Box flexDirection="column" borderStyle="double" paddingX={2} paddingY={1}>
			<Text bold color="yellow">GitHub Repository</Text>
			<Box marginTop={1}>
				<Text>Select GitHub account for repo creation:</Text>
			</Box>
			<Box marginTop={1}>
				<SelectInput
					items={ghItems}
					onSelect={(item) => {
						const ghAccount = item.value === "__skip__" ? undefined : item.value
						onRespond("infra_config", {
							mode: infraMode,
							...(ghAccount ? { ghAccount } : {}),
						})
					}}
				/>
			</Box>
			<Text dimColor>Esc dismiss</Text>
		</Box>
	)
}

function UserQuestionGate({
	event,
	onRespond,
	onDismiss,
}: {
	event: Extract<EngineEvent, { type: "ask_user_question" }>
	onRespond: (gate: string, data: Record<string, unknown>) => void
	onDismiss: () => void
}) {
	const [textValue, setTextValue] = useState("")
	const [customMode, setCustomMode] = useState(false)

	const respond = (answer: string) => {
		onRespond("ask_user_question", {
			toolUseId: event.tool_use_id,
			answers: { [event.question]: answer },
			_summary: answer,
		})
	}

	// Handle questions array (multi-question) — show first question's options
	const questions = event.questions ?? (event.question ? [{ question: event.question, options: event.options }] : [])
	const firstQ = questions[0]
	const options = firstQ?.options ?? event.options
	const questionText = firstQ?.question ?? event.question

	// Free-text input (no options, or custom mode)
	if (!options || options.length === 0 || customMode) {
		return (
			<Box flexDirection="column" borderStyle="double" paddingX={2} paddingY={1}>
				<Text bold color="yellow">Question from Agent</Text>
				<Box marginTop={1}>
					<Text wrap="wrap">{questionText}</Text>
				</Box>
				<Box marginTop={1}>
					<Text color="cyan">&gt; </Text>
					<TextInput
						value={textValue}
						onChange={setTextValue}
						onSubmit={(val) => {
							if (val.trim()) respond(val.trim())
						}}
						placeholder="Type your answer..."
					/>
				</Box>
				<Box marginTop={1}>
					<Text dimColor>
						Enter submit  Esc {customMode ? "back to options" : "dismiss"}
					</Text>
				</Box>
			</Box>
		)
	}

	// Options list + "Custom answer..." at the bottom
	const items = [
		...options.map((opt) => ({
			label: opt.description ? `${opt.label} - ${opt.description}` : opt.label,
			value: opt.label,
		})),
		{ label: "Custom answer...", value: "__custom__" },
	]

	return (
		<Box flexDirection="column" borderStyle="double" paddingX={2} paddingY={1}>
			<Text bold color="yellow">Question from Agent</Text>
			<Box marginTop={1}>
				<Text wrap="wrap">{questionText}</Text>
			</Box>
			<Box marginTop={1}>
				<SelectInput
					items={items}
					onSelect={(item) => {
						if (item.value === "__custom__") {
							setCustomMode(true)
						} else {
							respond(item.value)
						}
					}}
				/>
			</Box>
			<Text dimColor>Esc dismiss</Text>
		</Box>
	)
}

function OutboundMessageGate({
	event,
	onRespond,
	onDismiss,
}: {
	event: Extract<EngineEvent, { type: "outbound_message_gate" }>
	onRespond: (gate: string, data: Record<string, unknown>) => void
	onDismiss: () => void
}) {
	const items = [
		{ label: "[A]pprove - send as-is", value: "approve" },
		{ label: "[D]rop - discard message", value: "drop" },
	]

	return (
		<Box flexDirection="column" borderStyle="double" paddingX={2} paddingY={1}>
			<Text bold color="yellow">Outbound Message Approval</Text>
			{event.to && (
				<Text dimColor>To: {event.to}</Text>
			)}
			<Box marginTop={1} borderStyle="single" paddingX={1}>
				<Text wrap="wrap">{event.body}</Text>
			</Box>
			<Box marginTop={1}>
				<SelectInput
					items={items}
					onSelect={(item) => {
						onRespond("outbound_message_gate", {
							gateId: event.gateId,
							action: item.value,
						})
					}}
				/>
			</Box>
			<Text dimColor>Esc dismiss</Text>
		</Box>
	)
}
