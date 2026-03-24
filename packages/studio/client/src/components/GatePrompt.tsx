import { useEffect, useState } from "react"
import { type ProvisionResult, provisionElectric, respondToGate } from "../lib/api"
import type { ConsoleEntry, EngineEvent } from "../lib/event-types"
import { Duration } from "./ConsoleEntry"

type GateEntry = Extract<ConsoleEntry, { kind: "gate" }>

interface GatePromptProps {
	sessionId: string
	entry: GateEntry
	entryIndex: number
	onResolved: (index: number, summary?: string) => void
	roomId?: string
	roomName?: string
	respondFn?: (sessionId: string, gate: string, data: Record<string, unknown>) => Promise<unknown>
}

export function InfraConfigGate({
	sessionId,
	event,
	onResolved,
	resolved,
	resolvedDetails,
}: {
	sessionId: string
	event: Extract<EngineEvent, { type: "infra_config_prompt" }>
	onResolved: (summary: string) => void
	resolved?: boolean
	resolvedDetails?: Record<string, string>
}) {
	const isLocal = event.runtime === "docker"
	const [mode, setMode] = useState<"local" | "cloud" | "claim">(isLocal ? "local" : "claim")
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
	const [setupRepo, setSetupRepo] = useState(false)

	// Sync repoAccount when ghAccounts load asynchronously
	useEffect(() => {
		if (event.ghAccounts.length > 0) {
			setRepoAccount((prev) => prev || event.ghAccounts[0].login)
		}
	}, [event.ghAccounts])

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
				parts.push(`Database: ${databaseUrl}`)
				parts.push(`Source ID: ${sourceId}`)
				if (claimUrl) parts.push(`Claim: ${claimUrl}`)
			} else if (mode === "cloud") {
				payload.mode = "cloud"
				payload.databaseUrl = databaseUrl
				payload.electricUrl = electricUrl
				payload.sourceId = sourceId
				payload.secret = secret
				parts.push(`Database: ${databaseUrl}`)
				parts.push(`Source ID: ${sourceId}`)
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

			payload._summary = parts.join("\n")
			await respondToGate(sessionId, "infra_config", payload)
			onResolved(parts.join("\n"))
		} catch {
			setSubmitting(false)
		}
	}

	const disabled = submitting || !!resolved
	const cloudValid = databaseUrl.trim() && sourceId.trim() && secret.trim()
	const claimValid = provisioned && databaseUrl.trim() && sourceId.trim() && secret.trim()
	const repoValid = !setupRepo || (repoAccount && repoName.trim())

	const modeLabels = {
		claim: "Provisioned (Cloud)",
		local: "Local (Docker)",
		cloud: "Electric Cloud (BYO)",
	}

	if (resolved) {
		// Use server-provided details (works for both live + replay).
		// Fall back to component state for the brief moment before the SSE event arrives.
		const details: Record<string, string> = resolvedDetails ?? {}
		if (!resolvedDetails) {
			details.Infrastructure = modeLabels[mode]
			if (mode === "cloud" || mode === "claim") {
				if (databaseUrl) details["Connection string"] = databaseUrl
				if (sourceId) details["Source ID"] = sourceId
			}
			if (mode === "claim" && claimUrl) {
				details["Claim link"] = claimUrl
			}
			if (setupRepo && repoAccount && repoName.trim()) {
				details.Repository = `${repoAccount}/${repoName}`
				details.Visibility = repoVisibility
			}
		}
		return (
			<div className="gate-prompt">
				<div className="gate-config-summary">
					{Object.entries(details).map(([key, value]) => (
						<div key={key}>
							<strong>{key}:</strong>{" "}
							{value.startsWith("http") ? (
								<a href={value} target="_blank" rel="noopener noreferrer">
									{value}
								</a>
							) : (
								value
							)}
						</div>
					))}
				</div>
			</div>
		)
	}

	return (
		<div className="gate-prompt">
			<h3>Setup {event.projectName}</h3>

			<p className="gate-summary">Infrastructure</p>
			<div className="gate-option-group">
				<button
					type="button"
					className={`gate-option ${mode === "claim" ? "active" : ""}`}
					onClick={() => setMode("claim")}
					disabled={submitting}
				>
					<span className="gate-option-title">Provision</span>
					<span className="gate-option-desc">
						Auto-provision database &amp; Electric Cloud (72h)
					</span>
				</button>
				{isLocal && (
					<button
						type="button"
						className={`gate-option ${mode === "local" ? "active" : ""}`}
						onClick={() => setMode("local")}
						disabled={submitting}
					>
						<span className="gate-option-title">Local</span>
						<span className="gate-option-desc">Run with Docker Compose on your machine</span>
					</button>
				)}
				<button
					type="button"
					className={`gate-option ${mode === "cloud" ? "active" : ""}`}
					onClick={() => setMode("cloud")}
					disabled={submitting}
				>
					<span className="gate-option-title">Bring your own</span>
					<span className="gate-option-desc">Provide your own database &amp; Electric details</span>
				</button>
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
								disabled={provisioning || disabled}
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
							<p style={{ color: "var(--color-done, #d0bcff)", margin: "0 0 6px" }}>
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
							disabled={disabled}
							placeholder="postgresql://user:pass@host:5432/dbname"
						/>
					</div>
					<div className="question">
						<label>Electric URL</label>
						<input
							type="text"
							value={electricUrl}
							onChange={(e) => setElectricUrl(e.target.value)}
							disabled={disabled}
							placeholder="https://api.electric-sql.cloud"
						/>
					</div>
					<div className="question">
						<label>Source ID</label>
						<input
							type="text"
							value={sourceId}
							onChange={(e) => setSourceId(e.target.value)}
							disabled={disabled}
							placeholder="Your Electric Cloud source ID"
						/>
					</div>
					<div className="question">
						<label>Secret</label>
						<input
							type="password"
							value={secret}
							onChange={(e) => setSecret(e.target.value)}
							disabled={disabled}
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
					<div className="gate-option-group">
						<button
							type="button"
							className={`gate-option ${setupRepo ? "active" : ""}`}
							onClick={() => setSetupRepo(!setupRepo)}
							disabled={disabled}
						>
							<span className="gate-option-title">Create a GitHub repo for this project</span>
						</button>
					</div>
					{setupRepo && (
						<>
							<div className="question">
								<label>Account</label>
								{event.ghAccounts.length > 1 ? (
									<select
										value={repoAccount}
										onChange={(e) => setRepoAccount(e.target.value)}
										disabled={disabled}
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
									disabled={disabled}
									placeholder="my-app"
								/>
							</div>
							<div className="question">
								<label>Visibility</label>
								<div className="gate-option-group">
									<button
										type="button"
										className={`gate-option ${repoVisibility === "private" ? "active" : ""}`}
										onClick={() => setRepoVisibility("private")}
										disabled={disabled}
									>
										<span className="gate-option-title">Private</span>
									</button>
									<button
										type="button"
										className={`gate-option ${repoVisibility === "public" ? "active" : ""}`}
										onClick={() => setRepoVisibility("public")}
										disabled={disabled}
									>
										<span className="gate-option-title">Public</span>
									</button>
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
						disabled ||
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

interface NormalizedQuestion {
	question: string
	header?: string
	options?: Array<{ label: string; description?: string }>
	multiSelect?: boolean
}

export function AskUserQuestionGate({
	sessionId,
	event,
	onResolved,
	resolved,
	resolvedSummary,
	respondFn,
}: {
	sessionId: string
	event: Extract<EngineEvent, { type: "ask_user_question" }>
	onResolved: (summary: string) => void
	resolved?: boolean
	resolvedSummary?: string
	/** Override the default respondToGate call (e.g. for room-scoped respond) */
	respondFn?: (sessionId: string, gate: string, data: Record<string, unknown>) => Promise<unknown>
}) {
	const respond = respondFn ?? respondToGate
	// Normalize: use full questions array if present, else build single-item array
	const questions: NormalizedQuestion[] =
		Array.isArray(event.questions) && event.questions.length
			? event.questions
			: [{ question: event.question, options: event.options }]

	const hasMultipleQuestions = questions.length > 1
	const hasAnyMultiSelect = questions.some((q) => q.multiSelect)
	const needsSubmitButton = hasMultipleQuestions || hasAnyMultiSelect

	// State for answers: { [question]: "selected option or typed text" }
	const [answers, setAnswers] = useState<Record<string, string>>({})
	// State for multiSelect: { [question]: Set<string> }
	const [multiSelections, setMultiSelections] = useState<Record<string, Set<string>>>({})
	// Track which questions have custom input shown
	const [customInputs, setCustomInputs] = useState<Record<string, boolean>>({})
	// Custom text values per question
	const [customTexts, setCustomTexts] = useState<Record<string, string>>({})
	const [submitting, setSubmitting] = useState(false)
	const disabled = submitting || !!resolved

	function buildAnswersPayload(): Record<string, string> {
		const result: Record<string, string> = {}
		for (const q of questions) {
			if (q.multiSelect) {
				const selected = multiSelections[q.question]
				const custom = customTexts[q.question]?.trim()
				const parts = selected ? [...selected] : []
				if (custom) parts.push(custom)
				result[q.question] = parts.join(", ")
			} else {
				result[q.question] = answers[q.question] || customTexts[q.question]?.trim() || ""
			}
		}
		return result
	}

	function buildSummary(answersPayload: Record<string, string>): string {
		const entries = Object.entries(answersPayload).filter(([, v]) => v)
		if (entries.length === 1) return entries[0][1]
		return entries.map(([, a]) => a).join("; ")
	}

	// For single-question + single-select: instant submit on click
	async function handleInstantSubmit(question: string, label: string) {
		setAnswers((prev) => ({ ...prev, [question]: label }))
		setSubmitting(true)
		const answersPayload = { [question]: label }
		try {
			await respond(sessionId, "ask_user_question", {
				toolUseId: event.tool_use_id,
				answers: answersPayload,
				_summary: label,
			})
			onResolved(label)
		} catch (err) {
			console.error("[gate] handleInstantSubmit failed:", err)
			setAnswers((prev) => ({ ...prev, [question]: "" }))
			setSubmitting(false)
		}
	}

	async function handleSubmit() {
		const answersPayload = buildAnswersPayload()
		const summary = buildSummary(answersPayload)
		setSubmitting(true)
		try {
			await respond(sessionId, "ask_user_question", {
				toolUseId: event.tool_use_id,
				answers: answersPayload,
				_summary: summary,
			})
			onResolved(summary)
		} catch (err) {
			console.error("[gate] handleSubmit failed:", err)
			setSubmitting(false)
		}
	}

	function toggleMultiSelect(question: string, label: string) {
		setMultiSelections((prev) => {
			const set = new Set(prev[question] ?? [])
			if (set.has(label)) set.delete(label)
			else set.add(label)
			return { ...prev, [question]: set }
		})
	}

	// Resolved state — show same options with selected one highlighted
	if (resolved) {
		const selectedLabels = new Set(
			(resolvedSummary || "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
		)
		return (
			<div className="gate-prompt gate-prompt-resolved">
				<h3>Question</h3>
				{questions.map((q) => {
					const hasOptions = q.options && q.options.length > 0
					return (
						<div key={q.question} className="gate-question-section">
							{q.header && <span className="gate-question-header">{q.header}</span>}
							<p className="gate-summary">{q.question}</p>
							{hasOptions && (
								<div className="gate-option-group-vert">
									{q.options?.map((opt) => {
										const isSelected = selectedLabels.has(opt.label)
										return (
											<button
												key={opt.label}
												type="button"
												className={`gate-option ${isSelected ? "selected" : ""}`}
												disabled
											>
												{isSelected && <span className="gate-resolved-check">&#10003; </span>}
												<span className="gate-option-title">{opt.label}</span>
												{opt.description && (
													<span className="gate-option-desc">{opt.description}</span>
												)}
											</button>
										)
									})}
								</div>
							)}
							{!hasOptions && resolvedSummary && (
								<p className="gate-summary" style={{ opacity: 0.7 }}>{resolvedSummary}</p>
							)}
						</div>
					)
				})}
			</div>
		)
	}

	return (
		<div className="gate-prompt">
			<h3>Question</h3>
			{questions.map((q) => {
				const hasOptions = q.options && q.options.length > 0
				const showCustom = customInputs[q.question]

				return (
					<div key={q.question} className="gate-question-section">
						{q.header && <span className="gate-question-header">{q.header}</span>}
						<p className="gate-summary">{q.question}</p>

						{hasOptions && q.multiSelect && (
							<div className="gate-option-group-vert">
								{q.options?.map((opt) => {
									const isChecked = multiSelections[q.question]?.has(opt.label) ?? false
									return (
										<button
											key={opt.label}
											type="button"
											className={`gate-option gate-option-checkbox ${isChecked ? "checked" : ""}`}
											onClick={() => toggleMultiSelect(q.question, opt.label)}
											disabled={disabled}
										>
											<span className="gate-checkbox-indicator">
												{isChecked ? "\u2611" : "\u2610"}
											</span>
											<span className="gate-option-title">{opt.label}</span>
											{opt.description && (
												<span className="gate-option-desc">{opt.description}</span>
											)}
										</button>
									)
								})}
								{!showCustom && (
									<button
										type="button"
										className="gate-option gate-option-other"
										onClick={() => setCustomInputs((prev) => ({ ...prev, [q.question]: true }))}
										disabled={disabled}
									>
										<span className="gate-option-title">Other...</span>
									</button>
								)}
								{showCustom && (
									<div className="question">
										<input
											type="text"
											value={customTexts[q.question] || ""}
											onChange={(e) =>
												setCustomTexts((prev) => ({
													...prev,
													[q.question]: e.target.value,
												}))
											}
											disabled={disabled}
											placeholder="Type your answer..."
										/>
									</div>
								)}
							</div>
						)}

						{hasOptions && !q.multiSelect && (
							<div className="gate-option-group-vert">
								{q.options?.map((opt) => {
									const isSelected = answers[q.question] === opt.label
									return (
										<button
											key={opt.label}
											type="button"
											className={`gate-option ${isSelected ? "selected" : ""}`}
											onClick={() =>
												needsSubmitButton
													? setAnswers((prev) => ({ ...prev, [q.question]: opt.label }))
													: handleInstantSubmit(q.question, opt.label)
											}
											disabled={disabled}
										>
											<span className="gate-option-title">{opt.label}</span>
											{opt.description && (
												<span className="gate-option-desc">{opt.description}</span>
											)}
										</button>
									)
								})}
								{!showCustom && (
									<button
										type="button"
										className="gate-option gate-option-other"
										onClick={() => setCustomInputs((prev) => ({ ...prev, [q.question]: true }))}
										disabled={disabled}
									>
										<span className="gate-option-title">Other...</span>
									</button>
								)}
								{showCustom && (
									<div className="question">
										<input
											type="text"
											value={customTexts[q.question] || ""}
											onChange={(e) => {
												const val = e.target.value
												setCustomTexts((prev) => ({ ...prev, [q.question]: val }))
												// Clear option selection when typing custom
												setAnswers((prev) => ({ ...prev, [q.question]: "" }))
											}}
											disabled={disabled}
											placeholder="Type your answer..."
										/>
									</div>
								)}
							</div>
						)}

						{!hasOptions && (
							<div className="question">
								<textarea
									value={customTexts[q.question] || ""}
									onChange={(e) =>
										setCustomTexts((prev) => ({ ...prev, [q.question]: e.target.value }))
									}
									disabled={disabled}
									rows={3}
									placeholder="Type your answer..."
								/>
							</div>
						)}
					</div>
				)
			})}

			{needsSubmitButton && (
				<div className="gate-actions">
					<button className="gate-btn gate-btn-primary" onClick={handleSubmit} disabled={disabled}>
						{submitting ? "Submitting..." : "Submit"}
					</button>
				</div>
			)}
			{!needsSubmitButton && !questions[0]?.options?.length && (
				<div className="gate-actions">
					<button
						className="gate-btn gate-btn-primary"
						onClick={handleSubmit}
						disabled={disabled || !customTexts[questions[0]?.question]?.trim()}
					>
						{submitting ? "Submitting..." : "Submit"}
					</button>
				</div>
			)}
			{!needsSubmitButton &&
				questions[0]?.options?.length &&
				customInputs[questions[0]?.question] && (
					<div className="gate-actions">
						<button
							className="gate-btn gate-btn-primary"
							onClick={handleSubmit}
							disabled={disabled || !customTexts[questions[0]?.question]?.trim()}
						>
							{submitting ? "Submitting..." : "Submit"}
						</button>
					</div>
				)}
		</div>
	)
}

function resolvedLabel(type: string): string {
	switch (type) {
		case "infra_config_prompt":
			return "Project configured"
		case "ask_user_question":
			return "Question answered"
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
	roomId,
	roomName,
	respondFn,
}: GatePromptProps & { duration: string | null }) {
	const resolve = (summary?: string) => onResolved(entryIndex, summary)
	const { resolved, resolvedSummary } = entry

	let content: React.ReactNode = null
	switch (entry.event.type) {
		case "infra_config_prompt":
			content = (
				<InfraConfigGate
					sessionId={sessionId}
					event={entry.event}
					onResolved={resolve}
					resolved={resolved}
					resolvedDetails={entry.resolvedDetails}
				/>
			)
			break
		case "ask_user_question":
			content = (
				<AskUserQuestionGate
					sessionId={sessionId}
					event={entry.event}
					onResolved={resolve}
					resolved={resolved}
					resolvedSummary={resolvedSummary}
					respondFn={respondFn}
				/>
			)
			break
		default:
			return null
	}

	if (resolved) {
		return (
			<div className="gate-answered">
				<div className="gate-answered-header">
					<span className="prefix done">[gate]</span>
					<span className="gate-resolved-label">{resolvedLabel(entry.event.type)}</span>
					<Duration value={duration} />
				</div>
				{content}
				{roomId && (
					<a href={`/room/${roomId}`} className="gate-back-to-room">
						&larr; Back to {roomName || "Room"}
					</a>
				)}
			</div>
		)
	}

	return content
}
