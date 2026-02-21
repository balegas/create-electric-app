import { useEffect, useState } from "react"
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

	useEffect(() => {
		function handleKeyDown(e: KeyboardEvent) {
			if (e.key === "Enter" && !e.shiftKey && !submitting) {
				e.preventDefault()
				handleSubmit()
			}
		}
		document.addEventListener("keydown", handleKeyDown)
		return () => document.removeEventListener("keydown", handleKeyDown)
	})

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

	useEffect(() => {
		function handleKeyDown(e: KeyboardEvent) {
			if (submitting) return
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault()
				handleDecision("approve")
			} else if (e.key === "Escape") {
				e.preventDefault()
				handleDecision("cancel")
			}
		}
		document.addEventListener("keydown", handleKeyDown)
		return () => document.removeEventListener("keydown", handleKeyDown)
	})

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

	useEffect(() => {
		function handleKeyDown(e: KeyboardEvent) {
			if (submitting) return
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault()
				handleDecision(true)
			} else if (e.key === "Escape") {
				e.preventDefault()
				handleDecision(false)
			}
		}
		document.addEventListener("keydown", handleKeyDown)
		return () => document.removeEventListener("keydown", handleKeyDown)
	})

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

	// Repo setup fields
	const hasGh = event.ghAccounts.length > 0
	const [repoAccount, setRepoAccount] = useState(event.ghAccounts[0]?.login ?? "")
	const [repoName, setRepoName] = useState(event.projectName)
	const [repoVisibility, setRepoVisibility] = useState<"public" | "private">("private")
	const [setupRepo, setSetupRepo] = useState(hasGh)
	const [branchName, setBranchName] = useState(`electric-agent/${event.projectName}`)

	async function handleSubmit() {
		setSubmitting(true)
		const parts: string[] = []
		try {
			const payload: Record<string, unknown> = {}

			if (mode === "cloud") {
				payload.mode = "cloud"
				payload.databaseUrl = databaseUrl
				payload.electricUrl = electricUrl
				payload.sourceId = sourceId
				payload.secret = secret
				parts.push(`Electric Cloud`)
			} else {
				payload.mode = "local"
				parts.push("Local Docker")
			}

			if (setupRepo && repoAccount && repoName.trim()) {
				payload.repoAccount = repoAccount
				payload.repoName = repoName
				payload.repoVisibility = repoVisibility
				payload.branchName = branchName.trim() || `electric-agent/${event.projectName}`
				parts.push(`${repoAccount}/${repoName} (${repoVisibility}) → ${payload.branchName}`)
			}

			payload._summary = parts.join(" · ")
			await respondToGate(sessionId, "infra_config", payload)
			onResolved(parts.join(" · "))
		} catch {
			setSubmitting(false)
		}
	}

	const cloudValid = databaseUrl.trim() && sourceId.trim() && secret.trim()
	const repoValid = !setupRepo || (repoAccount && repoName.trim())
	const canSubmit = !submitting && (mode !== "cloud" || cloudValid) && repoValid

	useEffect(() => {
		function handleKeyDown(e: KeyboardEvent) {
			if (e.key === "Enter" && !e.shiftKey && canSubmit) {
				e.preventDefault()
				handleSubmit()
			}
		}
		document.addEventListener("keydown", handleKeyDown)
		return () => document.removeEventListener("keydown", handleKeyDown)
	})

	return (
		<div className="gate-prompt">
			<h3>Setup {event.projectName}</h3>

			<p className="gate-summary">Infrastructure</p>
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

			{hasGh && (
				<>
					<p className="gate-summary" style={{ marginTop: 16 }}>
						GitHub Repository
					</p>
					<div className="question">
						<label className="gate-radio" style={{ marginBottom: 8 }}>
							<input
								type="checkbox"
								checked={setupRepo}
								onChange={(e) => setSetupRepo(e.target.checked)}
								disabled={submitting}
							/>
							Create a GitHub repo for this project
						</label>
					</div>
					{setupRepo && (
						<>
							<div className="question">
								<label>Account</label>
								{event.ghAccounts.length > 1 ? (
									<select
										value={repoAccount}
										onChange={(e) => setRepoAccount(e.target.value)}
										disabled={submitting}
									>
										{event.ghAccounts.map((a) => (
											<option key={a.login} value={a.login}>
												{a.login} {a.type === "org" ? "(org)" : "(personal)"}
											</option>
										))}
									</select>
								) : (
									<input type="text" value={event.ghAccounts[0].login} disabled />
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
											name="repo-visibility"
											checked={repoVisibility === "private"}
											onChange={() => setRepoVisibility("private")}
											disabled={submitting}
										/>
										Private
									</label>
									<label className="gate-radio">
										<input
											type="radio"
											name="repo-visibility"
											checked={repoVisibility === "public"}
											onChange={() => setRepoVisibility("public")}
											disabled={submitting}
										/>
										Public
									</label>
								</div>
							</div>
							<div className="question">
								<label>Branch</label>
								<input
									type="text"
									value={branchName}
									onChange={(e) => setBranchName(e.target.value)}
									disabled={submitting}
									placeholder={`electric-agent/${event.projectName}`}
								/>
							</div>
						</>
					)}
				</>
			)}

			<div className="gate-actions">
				<button
					className="gate-btn gate-btn-primary"
					onClick={handleSubmit}
					disabled={submitting || (mode === "cloud" && !cloudValid) || !repoValid}
				>
					{submitting ? "Configuring..." : "Start"}
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
		case "infra_config_prompt":
			return "Project configured"
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
		case "infra_config_prompt":
			return <InfraConfigGate sessionId={sessionId} event={entry.event} onResolved={resolve} />
		default:
			return null
	}
}
