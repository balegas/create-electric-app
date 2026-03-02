/**
 * SessionBridge implementation that runs Codex CLI inside a Docker
 * container via `docker exec -i`, communicating via exec --json NDJSON.
 *
 * The bridge translates Codex's exec --json output into EngineEvents
 * and writes them to the Durable Stream for the UI.
 *
 * Codex runs in one-shot mode (`codex exec --json`) and exits after completing.
 * On iterate (follow-up message), the bridge respawns Codex with the new prompt.
 */

import { type ChildProcess, spawn } from "node:child_process"
import * as readline from "node:readline"
import { DurableStream } from "@durable-streams/client"
import type { EngineEvent } from "@electric-agent/protocol"
import { ts } from "@electric-agent/protocol"
import type { StreamConnectionInfo } from "../streams.js"
import { createCodexJsonParser } from "./codex-json-parser.js"
import type { SessionBridge, StreamMessage } from "./types.js"

export interface CodexDockerConfig {
	/** Initial prompt (the user's app description or task) */
	prompt: string
	/** Working directory inside the container */
	cwd: string
	/** Model to use (default: o4-mini) */
	model?: string
	/** Additional CLI flags */
	extraFlags?: string[]
}

export class CodexDockerBridge implements SessionBridge {
	readonly sessionId: string
	readonly streamUrl: string
	readonly streamHeaders: Record<string, string>

	private containerId: string
	private config: CodexDockerConfig
	private writer: DurableStream
	private parser = createCodexJsonParser()
	private agentEventCallbacks: Array<(event: EngineEvent) => void> = []
	private completeCallbacks: Array<(success: boolean) => void> = []
	private closed = false
	private proc: ChildProcess | null = null

	/** Codex thread ID captured from thread.started — used for resume */
	private codexThreadId: string | null = null
	/** Whether a Codex process is currently running */
	private running = false
	/** Whether the parser already emitted a session_end */
	private resultReceived = false

	constructor(
		sessionId: string,
		connection: StreamConnectionInfo,
		containerId: string,
		config: CodexDockerConfig,
	) {
		this.sessionId = sessionId
		this.streamUrl = connection.url
		this.streamHeaders = connection.headers
		this.containerId = containerId
		this.config = config

		this.writer = new DurableStream({
			url: connection.url,
			headers: connection.headers,
			contentType: "application/json",
		})
	}

	async emit(event: EngineEvent): Promise<void> {
		if (this.closed) return
		const msg: StreamMessage = { source: "server", ...event }
		await this.writer.append(JSON.stringify(msg))
	}

	/**
	 * Send a follow-up user message to Codex by respawning with a new prompt.
	 */
	async sendCommand(cmd: Record<string, unknown>): Promise<void> {
		if (this.closed) return

		if (cmd.command === "iterate" && typeof cmd.request === "string") {
			this.spawnCodex(cmd.request)
			return
		}

		console.log(`[codex-docker] Ignoring unsupported command: ${cmd.command}`)
	}

	/**
	 * Send a gate response. Codex exec mode doesn't support stdin interaction,
	 * so gate responses are limited.
	 */
	async sendGateResponse(_gate: string, _value: Record<string, unknown>): Promise<void> {
		// Codex exec --json doesn't support stdin user messages mid-run
	}

	onAgentEvent(cb: (event: EngineEvent) => void): void {
		this.agentEventCallbacks.push(cb)
	}

	onComplete(cb: (success: boolean) => void): void {
		this.completeCallbacks.push(cb)
	}

	async start(): Promise<void> {
		if (this.closed) return
		this.spawnCodex(this.config.prompt)
	}

	close(): void {
		this.closed = true
		if (this.proc) {
			try {
				this.proc.stdin?.end()
				this.proc.kill("SIGTERM")
			} catch {
				// Process may already be dead
			}
			this.proc = null
		}
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	/**
	 * Spawn a new Codex process. Called for both the initial prompt
	 * and follow-up iterate messages.
	 */
	private spawnCodex(prompt: string): void {
		// Kill any existing process
		if (this.proc) {
			try {
				this.proc.stdin?.end()
				this.proc.kill("SIGTERM")
			} catch {
				// Already dead
			}
			this.proc = null
		}

		// Reset parser state for the new process
		this.parser = createCodexJsonParser()
		this.resultReceived = false
		this.running = true

		const model = this.config.model ?? "o4-mini"

		// Build the codex CLI command
		const codexArgs = [
			"exec",
			"--json",
			"--full-auto",
			"--model",
			model,
			...(this.config.extraFlags ?? []),
			"-q",
			prompt,
		]

		// Escape for bash
		const escapedArgs = codexArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")
		const cmd = `cd '${this.config.cwd}' && codex ${escapedArgs}`

		this.proc = spawn("docker", ["exec", this.containerId, "bash", "-c", cmd], {
			stdio: ["pipe", "pipe", "pipe"],
		})

		console.log(
			`[codex-docker] Started: session=${this.sessionId} container=${this.containerId} pid=${this.proc.pid}`,
		)
		console.log(`[codex-docker] cmd: ${cmd}`)

		const currentProc = this.proc

		// Read stdout line by line (exec --json NDJSON)
		if (currentProc.stdout) {
			const rl = readline.createInterface({
				input: currentProc.stdout,
				terminal: false,
			})

			rl.on("line", (line) => {
				if (this.closed) return
				console.log(`[codex-docker:stdout] ${line.slice(0, 120)}...`)
				this.handleLine(line)
			})
		}

		// Log stderr
		if (currentProc.stderr) {
			const stderrRl = readline.createInterface({
				input: currentProc.stderr,
				terminal: false,
			})
			stderrRl.on("line", (line) => {
				if (!this.closed) {
					console.error(`[codex-docker:stderr] ${line}`)
				}
			})
		}

		// Handle process exit — defer to let pending readline events flush first
		currentProc.on("exit", (code) => {
			console.log(`[codex-docker] Process exited: code=${code} session=${this.sessionId}`)
			setTimeout(() => {
				// Capture thread ID from parser state before marking not running
				if (this.parser.state.threadId) {
					this.codexThreadId = this.parser.state.threadId
				}
				this.running = false

				// Emit session_end if the parser didn't already
				if (!this.closed && !this.resultReceived) {
					const endEvent: EngineEvent = {
						type: "session_end",
						success: code === 0,
						ts: ts(),
					}
					this.dispatchEvent(endEvent)
				}
			}, 100)
		})
	}

	private handleLine(line: string): void {
		const trimmed = line.trim()
		if (!trimmed) return

		const events = this.parser.parse(trimmed)
		for (const event of events) {
			this.dispatchEvent(event)
		}
	}

	private dispatchEvent(event: EngineEvent): void {
		// Write to Durable Stream for UI
		const msg: StreamMessage = { source: "agent", ...event }
		this.writer.append(JSON.stringify(msg)).catch(() => {})

		// Track session_end to prevent duplicates
		if (event.type === "session_end") {
			this.resultReceived = true
		}

		// Detect dev:start in Bash tool_use → emit app_ready for the UI preview
		if (event.type === "pre_tool_use" && event.tool_name === "Bash") {
			const cmd = (event.tool_input as Record<string, unknown>)?.command
			if (typeof cmd === "string" && /\bdev:start\b/.test(cmd)) {
				const appReady: EngineEvent = { type: "app_ready", ts: ts() }
				const appReadyMsg: StreamMessage = { source: "agent", ...appReady }
				this.writer.append(JSON.stringify(appReadyMsg)).catch(() => {})
				for (const cb of this.agentEventCallbacks) {
					try {
						cb(appReady)
					} catch {
						// Swallow
					}
				}
			}
		}

		// Dispatch to callbacks
		for (const cb of this.agentEventCallbacks) {
			try {
				cb(event)
			} catch {
				// Swallow callback errors
			}
		}

		// Detect session_end
		if (event.type === "session_end" && "success" in event) {
			const success = (event as EngineEvent & { success: boolean }).success
			for (const cb of this.completeCallbacks) {
				try {
					cb(success)
				} catch {
					// Swallow callback errors
				}
			}
		}
	}
}
