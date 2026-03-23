import React from "react"
import { Box, Text } from "ink"
import type { ConsoleEntry } from "../hooks/useSessionStream.js"
import { Markdown } from "./Markdown.js"
import { summarizeToolInput } from "../lib/formatting.js"

const LEVEL_COLORS: Record<string, string> = {
	plan: "cyan",
	approve: "green",
	task: "yellow",
	build: "blue",
	fix: "magenta",
	done: "green",
	system: "blue",
	error: "red",
	verbose: "gray",
}

interface ConsoleEntryViewProps {
	entry: ConsoleEntry
	expanded?: boolean
}

export const ConsoleEntryView = React.memo(function ConsoleEntryView({ entry, expanded }: ConsoleEntryViewProps) {
	switch (entry.kind) {
		case "log":
			return (
				<Box>
					<Text color={LEVEL_COLORS[entry.level] ?? "white"}>
						[{entry.level}]
					</Text>
					<Text> {entry.message}</Text>
				</Box>
			)

		case "user_prompt":
			return (
				<Box>
					<Text color="cyan" bold>
						[{entry.sender ?? "you"}]
					</Text>
					<Text> {entry.message}</Text>
				</Box>
			)

		case "assistant_message":
			return (
				<Box flexDirection="column">
					<Text color="green" bold>
						[{entry.agent || "agent"}]
					</Text>
					<Box marginLeft={2} flexDirection="column">
						<Markdown>{entry.text}</Markdown>
					</Box>
				</Box>
			)

		case "tool_use": {
			const summary = summarizeToolInput(entry.tool_name, entry.tool_input)
			const status = entry.tool_response === null ? "\u23f3" : "\u2713"
			const hasError = entry.tool_response?.startsWith("Error:")

			if (!expanded) {
				return (
					<Box>
						<Text color="gray">
							[tool] {entry.tool_name}
							{summary ? ` ${summary}` : ""}
						</Text>
						<Text color={hasError ? "red" : "green"}> [{status}]</Text>
					</Box>
				)
			}

			return (
				<Box flexDirection="column">
					<Box>
						<Text color="gray">[tool] {entry.tool_name}</Text>
						<Text color={hasError ? "red" : "green"}> [{status}]</Text>
					</Box>
					<Box marginLeft={2} flexDirection="column">
						<Text dimColor>Input: {JSON.stringify(entry.tool_input, null, 2)}</Text>
						{entry.tool_response && (
							<Text color={hasError ? "red" : undefined} dimColor>
								Output: {entry.tool_response.slice(0, 500)}
							</Text>
						)}
					</Box>
				</Box>
			)
		}

		case "todo_widget":
			return (
				<Box flexDirection="column" borderStyle="single" paddingX={1} marginY={0}>
					<Text bold>Tasks:</Text>
					{entry.todos.map((todo) => (
						<Box key={todo.id}>
							<Text color={todo.status === "completed" ? "green" : todo.status === "in_progress" ? "yellow" : "gray"}>
								{todo.status === "completed" ? " \u2713" : todo.status === "in_progress" ? " \u25b6" : " \u25cb"}
							</Text>
							<Text> {todo.content}</Text>
						</Box>
					))}
				</Box>
			)

		case "gate": {
			if (entry.resolved) {
				return (
					<Box>
						<Text color="green">{"✓"} Gate resolved</Text>
						{entry.resolvedSummary && <Text dimColor> - {entry.resolvedSummary}</Text>}
					</Box>
				)
			}
			const gateType = entry.event.type
			let label = "Input needed"
			if (gateType === "infra_config_prompt") label = "Infrastructure config needed"
			else if (gateType === "ask_user_question") label = "Question from agent"
			else if (gateType === "outbound_message_gate") label = "Message approval needed"

			return (
				<Box>
					<Text color="yellow" bold>
						{"⚠"} GATE: {label} {"—"} press ^G
					</Text>
				</Box>
			)
		}

		default:
			return null
	}
})
