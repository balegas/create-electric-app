import { useCallback, useState } from "react"
import { useEscapeKey, useKeyboardShortcut } from "../hooks/useKeyboardShortcut"
import { type ProvisionResult, provisionElectric, respondToGate } from "../lib/api"
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

	const handleDecision = useCallback(
		async (decision: "approve" | "revise" | "cancel") => {
			setSubmitting(true)
			const labels = {
				approve: "Plan approved",
				revise: "Revision requested",
				cancel: "Cancelled",
			}
			const summary = labels[decision]
			try {
				await respondToGate(sessionId, "approval", { decision, _summary: summary })
				onResolved(summary)
			} catch {
				setSubmitting(false)
			}
		},
		[sessionId, onResolved],
	)

	const approve = useCallback(() => handleDecision("approve"), [handleDecision])
	const cancel = useCallback(() => handleDecision("cancel"), [handleDecision])

	useKeyboardShortcut("Enter", approve, { disabled: submitting })
	useEscapeKey(cancel, submitting)

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
					Approve <kbd>Enter</kbd>
				</button>
				<button className="gate-btn" onClick={() => handleDecision("revise")} disabled={submitting}>
					Revise
				</button>
				<button
					className="gate-btn gate-btn-danger"
					onClick={() => handleDecision("cancel")}
					disabled={submitting}
				>
					Cancel <kbd>Esc</kbd>
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

	const handleDecision = useCallback(
		async (proceed: boolean) => {
			setSubmitting(true)
			const summary = proceed ? "Continued" : "Stopped"
			try {
				await respondToGate(sessionId, "continue", { proceed, _summary: summary })
				onResolved(summary)
			} catch {
				setSubmitting(false)
			}
		},
		[sessionId, onResolved],
	)

	const continueAction = useCallback(() => handleDecision(true), [handleDecision])
	const stopAction = useCallback(() => handleDecision(false), [handleDecision])

	useKeyboardShortcut("Enter", continueAction, { disabled: submitting })
	useEscapeKey(stopAction, submitting)

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
				Continue <kbd>Enter</kbd>
			</button>
			<button className="gate-btn" onClick={() => handleDecision(false)} disabled={submitting}>
				Stop <kbd>Esc</kbd>
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
	const [mode, setMode] = useState<"local" | "cloud" | "claim">("local")
	const [databaseUrl, setDatabaseUrl] = useState("")
	const [electricUrl, setElectricUrl] = useState("https://api.electric-sql.cloud")
	const [sourceId, setSourceId] = useState("")
	const [secret, setSecret] = useState("")
	const [claimId, setClaimId] = useState("")
	const [claimUrl, setClaimUrl] = useState("")
	const [submitting, setSubmitting] = useState(false)

	// Claim API provisioning state
	const [provisioning, setProvisioning] = useState(false)
	const [provisioned, setProvisioned] = useState(false)
	const [provisionError, setProvisionError] = useState<string | null>(null)

	// Repo setup fields
	const hasGh = event.ghAccounts.length > 0
	const [repoAccount, setRepoAccount] = useState(event.ghAccounts[0]?.login ?? "")
	const [repoName, setRepoName] = useState(event.projectName)
	const [repoVisibility, setRepoVisibility] = useState<"public" | "private">("private")
	const [setupRepo, setSetupRepo] = useState(hasGh)

	async function handleProvision() {
		setProvisioning(true)
		setProvisionError(null)
		try {
			const result: ProvisionResult = await provisionElectric()
			setDatabaseUrl(result.databaseUrl)
			setElectricUrl(result.electricUrl)
			setSourceId(result.sourceId)
			setSecret(result.secret)
			setClaimId(result.claimId)
			setClaimUrl(result.claimUrl)
			setProvisioned(true)
		} catch (err) {
			setProvisionError(err instanceof Error ? err.message : "Provisioning failed")
		} finally {
			setProvisioning(false)
		}
	}

	async function handleSubmit() {
		setSubmitting(true)
		const parts: string[] = []
		try {
			const payload: Record<string, unknown> = {}

			if (mode === "claim") {
				payload.mode = "claim"
				payload.databaseUrl = databaseUrl
				payload.electricUrl = electricUrl
				payload.sourceId = sourceId
				payload.secret = secret
				payload.claimId = claimId
				parts.push(`Quick Start (Cloud) — claim: ${claimUrl}`)
			} else if (mode === "cloud") {
				payload.mode = "cloud"
				payload.databaseUrl = databaseUrl
				payload.electricUrl = electricUrl
				payload.sourceId = sourceId
				payload.secret = secret
				parts.push("Electric Cloud")
			} else {
				payload.mode = "local"
				parts.push("Local Docker")
			}

			if (setupRepo && repoAccount && repoName.trim()) {
				payload.repoAccount = repoAccount
				payload.repoName = repoName
				payload.repoVisibility = repoVisibility
				parts.push(`${repoAccount}/${repoName} (${repoVisibility})`)
			}

			payload._summary = parts.join(" · ")
			await respondToGate(sessionId, "infra_config", payload)
			onResolved(parts.join(" · "))
		} catch {
			setSubmitting(false)
		}
	}

	const cloudValid = databaseUrl.trim() && sourceId.trim() && secret.trim()
	const claimValid = provisioned && databaseUrl.trim() && sourceId.trim() && secret.trim()
	const repoValid = !setupRepo || (repoAccount && repoName.trim())

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
							checked={mode === "claim"}
							onChange={() => setMode("claim")}
							disabled={submitting}
						/>
						Quick Start (Cloud)
					</label>
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
						Electric Cloud (BYO)
					</label>
				</div>
			</div>
			{mode === "claim" && (
				<div className="question">
					{!provisioned ? (
						<>
							<p style={{ fontSize: "0.85em", opacity: 0.7, margin: "0 0 8px" }}>
								Automatically provision a Neon Postgres database and Electric Cloud source.
								Resources are available for 72 hours.
							</p>
							<button
								className="gate-btn gate-btn-primary"
								onClick={handleProvision}
								disabled={provisioning || submitting}
								style={{ marginBottom: 8 }}
							>
								{provisioning ? "Provisioning..." : "Provision Resources"}
							</button>
							{provisioning && (
								<p style={{ fontSize: "0.85em", opacity: 0.7 }}>This may take 30-60 seconds...</p>
							)}
							{provisionError && (
								<p style={{ color: "var(--color-error, #e55)", fontSize: "0.85em" }}>
									{provisionError}
								</p>
							)}
						</>
					) : (
						<div style={{ fontSize: "0.85em" }}>
							<p style={{ color: "var(--color-done, #4c4)", margin: "0 0 6px" }}>
								Resources provisioned successfully (72h TTL).
							</p>
							<div
								style={{
									background: "rgba(255,255,255,0.04)",
									border: "1px solid rgba(255,255,255,0.1)",
									borderRadius: 6,
									padding: "8px 10px",
									margin: "6px 0",
									fontFamily: "monospace",
									fontSize: "0.9em",
									lineHeight: 1.6,
									wordBreak: "break-all",
								}}
							>
								<div>
									<strong>Database URL:</strong> {databaseUrl}
								</div>
								<div>
									<strong>Source ID:</strong> {sourceId}
								</div>
								<div>
									<strong>Electric URL:</strong> {electricUrl}
								</div>
							</div>
							{claimUrl && (
								<p style={{ margin: "8px 0 0" }}>
									Claim into your account:{" "}
									<a
										href={claimUrl}
										target="_blank"
										rel="noopener noreferrer"
										style={{ wordBreak: "break-all" }}
									>
										{claimUrl}
									</a>
								</p>
							)}
						</div>
					)}
				</div>
			)}
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
						</>
					)}
				</>
			)}

			<div className="gate-actions">
				<button
					className="gate-btn gate-btn-primary"
					onClick={handleSubmit}
					disabled={
						submitting ||
						(mode === "cloud" && !cloudValid) ||
						(mode === "claim" && !claimValid) ||
						!repoValid
					}
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
