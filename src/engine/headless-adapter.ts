import readline from "node:readline"
import type { EngineEvent } from "./events.js"
import type { OrchestratorCallbacks } from "./orchestrator.js"

export interface HeadlessConfig {
	command: "new" | "iterate" | "git"
	description?: string
	projectName?: string
	baseDir?: string
	projectDir?: string
	request?: string
	resumeSessionId?: string
	initGit?: boolean
	gitOp?: "commit" | "push" | "create-repo" | "create-pr"
	gitMessage?: string
	gitRepoName?: string
	gitRepoVisibility?: "public" | "private"
	gitPrTitle?: string
	gitPrBody?: string
}

/**
 * Single readline over stdin that handles both the initial config line
 * and subsequent gate response lines. This avoids creating multiple
 * readline interfaces on the same stream (which causes data loss)
 * and handles the case where stdin closes before readline attaches
 * (piped input in Docker).
 *
 * Stdin protocol (controller -> headless):
 *   Line 1: JSON config — {"command":"new","description":"..."}
 *   Lines 2+: gate responses — {"gate":"approval","decision":"approve"}
 */
class StdinReader {
	private pending = new Map<string, { resolve: (value: unknown) => void }>()
	private configResolve: ((config: HeadlessConfig) => void) | null = null
	private configReject: ((err: Error) => void) | null = null
	private gotConfig = false
	private rl: readline.Interface

	constructor() {
		// Buffer stdin so data isn't lost before readline attaches
		process.stdin.resume()

		this.rl = readline.createInterface({
			input: process.stdin,
			terminal: false,
		})

		this.rl.on("line", (line) => {
			const trimmed = line.trim()
			if (!trimmed) return

			try {
				const msg = JSON.parse(trimmed) as Record<string, unknown>

				// First valid JSON line is the config
				if (!this.gotConfig) {
					this.gotConfig = true
					if (!msg.command) {
						this.configReject?.(
							new Error('Config must include a "command" field ("new" or "iterate")'),
						)
						return
					}
					this.configResolve?.(msg as unknown as HeadlessConfig)
					return
				}

				// Check if this is a new command (iterate)
				if (msg.command) {
					const entry = this.pending.get("command")
					if (entry) {
						this.pending.delete("command")
						entry.resolve(msg)
					}
					return
				}

				// Subsequent lines are gate responses
				const gate = msg.gate as string | undefined
				if (!gate) return

				const entry = this.pending.get(gate)
				if (entry) {
					this.pending.delete(gate)
					entry.resolve(msg)
				}
			} catch {
				if (!this.gotConfig) {
					this.configReject?.(new Error("First line of stdin must be valid JSON config"))
				}
				// Ignore malformed gate lines
			}
		})

		this.rl.on("close", () => {
			if (!this.gotConfig) {
				this.configReject?.(new Error("Stdin closed before config was received"))
			}
		})
	}

	/** Wait for the first line to arrive as config. */
	readConfig(): Promise<HeadlessConfig> {
		if (this.gotConfig) {
			return Promise.reject(new Error("Config already read"))
		}
		return new Promise<HeadlessConfig>((resolve, reject) => {
			this.configResolve = resolve
			this.configReject = reject
		})
	}

	/** Wait for a gate response line matching the given gate name. */
	waitFor<T>(gateName: string): Promise<T> {
		return new Promise<T>((resolve) => {
			this.pending.set(gateName, {
				resolve: resolve as (value: unknown) => void,
			})
		})
	}

	/** Wait for the next "command" line (used for iterate after initial run). */
	waitForCommand(): Promise<HeadlessConfig> {
		return this.waitFor<HeadlessConfig>("command")
	}

	close(): void {
		this.rl.close()
	}
}

/**
 * Create a headless adapter that communicates via NDJSON on stdin/stdout.
 *
 * Stdout: one JSON-encoded EngineEvent per line
 * Stdin: first line is config, subsequent lines are gate responses
 *
 * Returns `readConfig()` to get the initial config, `callbacks` for the
 * orchestrator, and `close()` to clean up.
 */
export function createHeadlessAdapter(): {
	readConfig: () => Promise<HeadlessConfig>
	waitForCommand: () => Promise<HeadlessConfig>
	callbacks: OrchestratorCallbacks
	close: () => void
} {
	const reader = new StdinReader()

	const callbacks: OrchestratorCallbacks = {
		onEvent(event: EngineEvent) {
			process.stdout.write(`${JSON.stringify(event)}\n`)
		},

		async onClarificationNeeded(_questions, _summary) {
			const response = await reader.waitFor<{ answers: string[] }>("clarification")
			return response.answers
		},

		async onPlanReady(_plan) {
			const response = await reader.waitFor<{ decision: "approve" | "revise" | "cancel" }>(
				"approval",
			)
			return response.decision
		},

		async onRevisionRequested() {
			const response = await reader.waitFor<{ feedback: string }>("revision")
			return response.feedback
		},

		async onContinueNeeded() {
			const response = await reader.waitFor<{ proceed: boolean }>("continue")
			return response.proceed
		},
	}

	return {
		readConfig: () => reader.readConfig(),
		waitForCommand: () => reader.waitForCommand(),
		callbacks,
		close: () => reader.close(),
	}
}
