import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { highlight } from "sugar-high"

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
	const code = String(children).replace(/\n$/, "")
	const isInline = !className

	if (isInline) {
		return <code>{children}</code>
	}

	const html = highlight(code)
	// biome-ignore lint/security/noDangerouslySetInnerHtml: sugar-high produces safe span-only HTML
	return <code dangerouslySetInnerHTML={{ __html: html }} />
}

interface MarkdownProps {
	children: string
	inline?: boolean
}

export function Markdown({ children, inline }: MarkdownProps) {
	return (
		<div className={inline ? "markdown-inline" : "markdown"}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					code: CodeBlock,
				}}
			>
				{children}
			</ReactMarkdown>
		</div>
	)
}
