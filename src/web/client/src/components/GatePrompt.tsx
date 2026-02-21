import { useState } from "react"
import { respondToGate } from "../lib/api"
import type { ConsoleEntry, EngineEvent } from "../lib/event-types"
import { Duration } from "./ConsoleEntry"
import { Markdown } from "./Markdown"

type GateEntry = Extract<ConsoleEntry, { kind: "gate" }>

interface GatePromptProps {
	sessionId: string
	entry: GateEntry
	entryIndex: number
	onResolved: (index: number, summary?: string) => void
}

function ClarificationGate({
	sessionId,
	event,
	onResolved,
}: {
	sessionId: string
	event: Extract<EngineEvent, { type: "clarification_needed" }>
	onResolved: (summary: string) => void
}) {
	const [answers, setAnswers] = useState<string[]>(event.questions.map(() => ""))
	const [extra, setExtra] = useState("")
	const [submitting, setSubmitting] = useState(false)

	async function handleSubmit() {
		setSubmitting(true)
		const filled = answers.filter((a) => a.trim())
		const summary = filled.length > 0 ? filled.join("; ") : "Answers provided"
		try {
			await respondToGate(sessionId, "clarification", {
				answers: [...answers, extra],
				_summary: summary,
			})
			onResolved(summary)
		} catch {
			setSubmitting(false)
		}
	}

	return (
		<div className="gate-prompt">
			<h3>Need more details (confidence: {event.confidence}%)</h3>
			{event.summary && <p className="gate-summary">{event.summary}</p>}
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
			<div className="question">
				<label>Anything else you'd like to add?</label>
				<textarea
					value={extra}
					onChange={(e) => setExtra(e.target.value)}
					disabled={submitting}
					rows={3}
					placeholder="Optional: add any extra context, requirements, or preferences..."
				/>
			</div>
			<div className="gate-actions">
				<button className="gate-btn gate-btn-primary" onClick={handleSubmit} disabled={submitting}>
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
	onResolved: (summary: string) => void
}) {
	const [submitting, setSubmitting] = useState(false)

	async function handleDecision(decision: "approve" | "revise" | "cancel") {
		setSubmitting(true)
		const labels = { approve: "Plan approved", revise: "Revision requested", cancel: "Cancelled" }
		const summary = labels[decision]
		try {
			await respondToGate(sessionId, "approval", { decision, _summary: summary })
			onResolved(summary)
		} catch {
			setSubmitting(false)
		}
	}

	return (
		<div className="gate-plan">
			<div className="gate-plan-body">
				<Markdown>{event.plan}</Markdown>
			</div>
			<div className="gate-plan-actions">
				<button
					className="gate-btn gate-btn-primary"
					onClick={() => handleDecision("approve")}
					disabled={submitting}
				>
					Approve
				</button>
				<button className="gate-btn" onClick={() => handleDecision("revise")} disabled={submitting}>
					Revise
				</button>
				<button
					className="gate-btn gate-btn-danger"
					onClick={() => handleDecision("cancel")}
					disabled={submitting}
				>
					Cancel
				</button>
			</div>
		</div>
	)
}

function ContinueGate({
	sessionId,
	reason,
	onResolved,
}: {
	sessionId: string
	reason: string
	onResolved: (summary: string) => void
}) {
	const [submitting, setSubmitting] = useState(false)

	async function handleDecision(proceed: boolean) {
		setSubmitting(true)
		const summary = proceed ? "Continued" : "Stopped"
		try {
			await respondToGate(sessionId, "continue", { proceed, _summary: summary })
			onResolved(summary)
		} catch {
			setSubmitting(false)
		}
	}

	const isBudget = reason === "max_budget"

	return (
		<div className="gate-continue">
			<span className="gate-continue-text">
				{isBudget
					? "Budget limit reached. Continue with additional budget?"
					: "Turn limit reached. Continue?"}
			</span>
			<button
				className="gate-btn gate-btn-primary"
				onClick={() => handleDecision(true)}
				disabled={submitting}
			>
				Continue
			</button>
			<button className="gate-btn" onClick={() => handleDecision(false)} disabled={submitting}>
				Stop
			</button>
		</div>
	)
}

function PublishGate({
	sessionId,
	event,
	onResolved,
}: {
	sessionId: string
	event: Extract<EngineEvent, { type: "publish_prompt" }>
	onResolved: (summary: string) => void
}) {
	const [account, setAccount] = useState(event.accounts[0]?.login ?? "")
	const [repoName, setRepoName] = useState(event.defaultRepoName)
	const [visibility, setVisibility] = useState<"public" | "private">("private")
	const [submitting, setSubmitting] = useState(false)

	async function handleSubmit() {
		setSubmitting(true)
		const fullName = account ? `${account}/${repoName}` : repoName
		const summary = `${fullName} (${visibility})`
		try {
			await respondToGate(sessionId, "publish", {
				account,
				repoName,
				visibility,
				_summary: summary,
			})
			onResolved(summary)
		} catch {
			setSubmitting(false)
		}
	}

	return (
		<div className="gate-prompt">
			<h3>Publish to GitHub</h3>
			<div className="question">
				<label>Account</label>
				{event.accounts.length > 1 ? (
					<select
						value={account}
						onChange={(e) => setAccount(e.target.value)}
						disabled={submitting}
					>
						{event.accounts.map((a) => (
							<option key={a.login} value={a.login}>
								{a.login} {a.type === "org" ? "(org)" : "(personal)"}
							</option>
						))}
					</select>
				) : event.accounts.length === 1 ? (
					<input type="text" value={event.accounts[0].login} disabled />
				) : (
					<input
						type="text"
						value={account}
						onChange={(e) => setAccount(e.target.value)}
						disabled={submitting}
						placeholder="github-username-or-org"
					/>
				)}
			</div>
			<div className="question">
				<label>Repository name</label>
				<input
					type="text"
					value={repoName}
					onChange={(e) => setRepoName(e.target.value)}
					disabled={submitting}
					placeholder="my-app"
				/>
			</div>
			<div className="question">
				<label>Visibility</label>
				<div className="gate-radio-group">
					<label className="gate-radio">
						<input
							type="radio"
							name="visibility"
							checked={visibility === "private"}
							onChange={() => setVisibility("private")}
							disabled={submitting}
						/>
						Private
					</label>
					<label className="gate-radio">
						<input
							type="radio"
							name="visibility"
							checked={visibility === "public"}
							onChange={() => setVisibility("public")}
							disabled={submitting}
						/>
						Public
					</label>
				</div>
			</div>
			<div className="gate-actions">
				<button
					className="gate-btn gate-btn-primary"
					onClick={handleSubmit}
					disabled={submitting || !repoName.trim()}
				>
					{submitting ? "Publishing..." : "Publish"}
				</button>
			</div>
		</div>
	)
}

function CheckpointGate({
	sessionId,
	onResolved,
}: {
	sessionId: string
	onResolved: (summary: string) => void
}) {
	const [message, setMessage] = useState("")
	const [submitting, setSubmitting] = useState(false)

	async function handleSubmit() {
		setSubmitting(true)
		const summary = message || "Auto-generated commit message"
		try {
			await respondToGate(sessionId, "checkpoint", {
				message: message || undefined,
				_summary: summary,
			})
			onResolved(summary)
		} catch {
			setSubmitting(false)
		}
	}

	return (
		<div className="gate-prompt">
			<h3>Checkpoint</h3>
			<div className="question">
				<label>Commit message (optional)</label>
				<input
					type="text"
					value={message}
					onChange={(e) => setMessage(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") handleSubmit()
					}}
					disabled={submitting}
					placeholder="Auto-generated if empty"
				/>
			</div>
			<div className="gate-actions">
				<button className="gate-btn gate-btn-primary" onClick={handleSubmit} disabled={submitting}>
					{submitting ? "Committing..." : "Commit"}
				</button>
			</div>
		</div>
	)
}

function InfraConfigGate({
	sessionId,
	event,
	onResolved,
}: {
	sessionId: string
	event: Extract<EngineEvent, { type: "infra_config_prompt" }>
	onResolved: (summary: string) => void
}) {
	const [mode, setMode] = useState<"local" | "cloud">("local")
	const [databaseUrl, setDatabaseUrl] = useState("")
	const [electricUrl, setElectricUrl] = useState("https://api.electric-sql.cloud")
	const [sourceId, setSourceId] = useState("")
	const [secret, setSecret] = useState("")
	const [submitting, setSubmitting] = useState(false)

	async function handleSubmit() {
		setSubmitting(true)
		try {
			if (mode === "cloud") {
				const summary = `Electric Cloud (${electricUrl})`
				await respondToGate(sessionId, "infra_config", {
					mode: "cloud",
					databaseUrl,
					electricUrl,
					sourceId,
					secret,
					_summary: summary,
				})
				onResolved(summary)
			} else {
				const summary = "Local Docker (Postgres + Electric)"
				await respondToGate(sessionId, "infra_config", {
					mode: "local",
					_summary: summary,
				})
				onResolved(summary)
			}
		} catch {
			setSubmitting(false)
		}
	}

	const cloudValid = databaseUrl.trim() && sourceId.trim() && secret.trim()

	return (
		<div className="gate-prompt">
			<h3>Infrastructure for {event.projectName}</h3>
			<p className="gate-summary">Choose how to run Postgres and Electric for this project.</p>
			<div className="question">
				<div className="gate-radio-group">
					<label className="gate-radio">
						<input
							type="radio"
							name="infra-mode"
							checked={mode === "local"}
							onChange={() => setMode("local")}
							disabled={submitting}
						/>
						Local (Docker)
					</label>
					<label className="gate-radio">
						<input
							type="radio"
							name="infra-mode"
							checked={mode === "cloud"}
							onChange={() => setMode("cloud")}
							disabled={submitting}
						/>
						Electric Cloud
					</label>
				</div>
			</div>
			{mode === "cloud" && (
				<>
					<div className="question">
						<label>Database URL</label>
						<input
							type="text"
							value={databaseUrl}
							onChange={(e) => setDatabaseUrl(e.target.value)}
							disabled={submitting}
							placeholder="postgresql://user:pass@host:5432/dbname"
						/>
					</div>
					<div className="question">
						<label>Electric URL</label>
						<input
							type="text"
							value={electricUrl}
							onChange={(e) => setElectricUrl(e.target.value)}
							disabled={submitting}
							placeholder="https://api.electric-sql.cloud"
						/>
					</div>
					<div className="question">
						<label>Source ID</label>
						<input
							type="text"
							value={sourceId}
							onChange={(e) => setSourceId(e.target.value)}
							disabled={submitting}
							placeholder="Your Electric Cloud source ID"
						/>
					</div>
					<div className="question">
						<label>Secret</label>
						<input
							type="password"
							value={secret}
							onChange={(e) => setSecret(e.target.value)}
							disabled={submitting}
							placeholder="Your Electric Cloud secret"
						/>
					</div>
				</>
			)}
			<div className="gate-actions">
				<button
					className="gate-btn gate-btn-primary"
					onClick={handleSubmit}
					disabled={submitting || (mode === "cloud" && !cloudValid)}
				>
					{submitting ? "Configuring..." : mode === "local" ? "Use Docker" : "Connect to Cloud"}
				</button>
			</div>
		</div>
	)
}

function resolvedLabel(type: string): string {
	switch (type) {
		case "clarification_needed":
			return "Clarification answered"
		case "plan_ready":
			return "Plan reviewed"
		case "publish_prompt":
			return "Published to GitHub"
		case "checkpoint_prompt":
			return "Checkpoint created"
		case "infra_config_prompt":
			return "Infrastructure configured"
		case "continue_needed":
			return "Decision made"
		default:
			return "Decision made"
	}
}

export function GatePrompt({
	sessionId,
	entry,
	entryIndex,
	onResolved,
	duration,
}: GatePromptProps & { duration: string | null }) {
	if (entry.resolved) {
		const label = resolvedLabel(entry.event.type)
		const summary = entry.resolvedSummary

		return (
			<details className="gate-resolved-details">
				<summary>
					<span className="prefix done">[gate]</span>
					<span className="gate-resolved-label">{label}</span>
					<Duration value={duration} />
				</summary>
				{summary && (
					<div className="gate-resolved-body">
						<pre>{summary}</pre>
					</div>
				)}
			</details>
		)
	}

	const resolve = (summary?: string) => onResolved(entryIndex, summary)

	switch (entry.event.type) {
		case "clarification_needed":
			return <ClarificationGate sessionId={sessionId} event={entry.event} onResolved={resolve} />
		case "plan_ready":
			return <PlanGate sessionId={sessionId} event={entry.event} onResolved={resolve} />
		case "continue_needed":
			return <ContinueGate sessionId={sessionId} reason={entry.event.reason} onResolved={resolve} />
		case "publish_prompt":
			return <PublishGate sessionId={sessionId} event={entry.event} onResolved={resolve} />
		case "checkpoint_prompt":
			return <CheckpointGate sessionId={sessionId} onResolved={resolve} />
		case "infra_config_prompt":
			return <InfraConfigGate sessionId={sessionId} event={entry.event} onResolved={resolve} />
		default:
			return null
	}
}
