import React from "react"
import { Text } from "ink"
import { Marked } from "marked"
import { markedTerminal } from "marked-terminal"

const md = new Marked(markedTerminal({
	reflowText: true,
	width: process.stdout.columns ?? 80,
}))

interface MarkdownProps {
	children: string
}

export const Markdown = React.memo(function Markdown({ children }: MarkdownProps) {
	const rendered = md.parse(children) as string
	return <Text>{rendered.trimEnd()}</Text>
})
