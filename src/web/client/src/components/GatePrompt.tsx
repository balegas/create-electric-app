import { useState } from "react"
import { respondToGate } from "../lib/api"
import type { ConsoleEntry, EngineEvent } from "../lib/event-types"

type GateEntry = Extract<ConsoleEntry, { kind: "gate" }>

interface GatePromptProps {
	sessionId: string
	entry: GateEntry
	entryIndex: number
	onResolved: (index: number) => void
}

function ClarificationGate({
	sessionId,
	event,
	onResolved,
}: {
	sessionId: string
	event: Extract<EngineEvent, { type: "clarification_needed" }>
	onResolved: () => void
}) {
	const [answers, setAnswers] = useState<string[]>(event.questions.map(() => ""))
	const [submitting, setSubmitting] = useState(false)

	async function handleSubmit() {
		setSubmitting(true)
		try {
			await respondToGate(sessionId, "clarification", { answers })
			onResolved()
		} catch {
			setSubmitting(false)
		}
	}

	return (
		<div className="gate-prompt">
			<h3>Need more details (confidence: {event.confidence}%)</h3>
			{event.summary && (
				<p style={{ color: "var(--text-muted)", marginBottom: 12 }}>{event.summary}</p>
			)}
			{event.questions.map((q, i) => (
				<div className="question" key={i}>
					<label>
						{i + 1}. {q}
					</label>
					<input
						type="text"
						value={answers[i]}
						onChange={(e) => {
							const next = [...answers]
							next[i] = e.target.value
							setAnswers(next)
						}}
						disabled={submitting}
					/>
				</div>
			))}
			<div className="actions">
				<button className="primary" onClick={handleSubmit} disabled={submitting}>
					{submitting ? "Submitting..." : "Submit Answers"}
				</button>
			</div>
		</div>
	)
}

function PlanGate({
	sessionId,
	event,
	onResolved,
}: {
	sessionId: string
	event: Extract<EngineEvent, { type: "plan_ready" }>
	onResolved: () => void
}) {
	const [submitting, setSubmitting] = useState(false)

	async function handleDecision(decision: "approve" | "revise" | "cancel") {
		setSubmitting(true)
		try {
			await respondToGate(sessionId, "approval", { decision })
			onResolved()
		} catch {
			setSubmitting(false)
		}
	}

	return (
		<div className="gate-prompt">
			<h3>Implementation Plan</h3>
			<div className="plan-preview">{event.plan}</div>
			<div className="actions">
				<button className="primary" onClick={() => handleDecision("approve")} disabled={submitting}>
					Approve
				</button>
				<button onClick={() => handleDecision("revise")} disabled={submitting}>
					Revise
				</button>
				<button className="danger" onClick={() => handleDecision("cancel")} disabled={submitting}>
					Cancel
				</button>
			</div>
		</div>
	)
}

function ContinueGate({ sessionId, onResolved }: { sessionId: string; onResolved: () => void }) {
	const [submitting, setSubmitting] = useState(false)

	async function handleDecision(proceed: boolean) {
		setSubmitting(true)
		try {
			await respondToGate(sessionId, "continue", { proceed })
			onResolved()
		} catch {
			setSubmitting(false)
		}
	}

	return (
		<div className="gate-prompt">
			<h3>Agent reached turn limit</h3>
			<p style={{ color: "var(--text-muted)", marginBottom: 12 }}>
				The agent needs more turns to finish. Continue?
			</p>
			<div className="actions">
				<button className="primary" onClick={() => handleDecision(true)} disabled={submitting}>
					Continue
				</button>
				<button onClick={() => handleDecision(false)} disabled={submitting}>
					Stop
				</button>
			</div>
		</div>
	)
}

export function GatePrompt({ sessionId, entry, entryIndex, onResolved }: GatePromptProps) {
	if (entry.resolved) {
		// Show collapsed resolved state
		const label =
			entry.event.type === "clarification_needed"
				? "Clarification answered"
				: entry.event.type === "plan_ready"
					? "Plan reviewed"
					: "Decision made"
		return (
			<div className="console-entry">
				<span className="prefix done">[gate]</span>
				<span style={{ color: "var(--text-subtle)" }}>{label}</span>
			</div>
		)
	}

	const resolve = () => onResolved(entryIndex)

	switch (entry.event.type) {
		case "clarification_needed":
			return <ClarificationGate sessionId={sessionId} event={entry.event} onResolved={resolve} />
		case "plan_ready":
			return <PlanGate sessionId={sessionId} event={entry.event} onResolved={resolve} />
		case "continue_needed":
			return <ContinueGate sessionId={sessionId} onResolved={resolve} />
		default:
			return null
	}
}
