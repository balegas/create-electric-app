import DOMPurify from "dompurify"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { highlight } from "sugar-high"

/** Sanitize HTML to only allow safe tags produced by sugar-high (spans with style) */
function sanitizeHighlightedHtml(html: string): string {
	return DOMPurify.sanitize(html, {
		ALLOWED_TAGS: ["span"],
		ALLOWED_ATTR: ["style", "class"],
	})
}

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
	const code = String(children).replace(/\n$/, "")
	const isInline = !className

	if (isInline) {
		return <code>{children}</code>
	}

	const html = sanitizeHighlightedHtml(highlight(code))
	// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify
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
