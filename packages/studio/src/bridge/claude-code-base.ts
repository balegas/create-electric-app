/**
 * Abstract base class for Claude Code bridges (Docker and Sprites).
 *
 * Encapsulates the shared logic for:
 * - Durable Stream writing (emit, dispatchEvent)
 * - Message queueing (sendCommand with queue-if-busy)
 * - Event dispatching (callbacks, app_status detection)
 * - Process lifecycle (exit handling, queue draining, session_end)
 * - Gate responses
 *
 * Subclasses implement the platform-specific process management:
 * - spawnProcess() — start a new Claude Code process
 * - killProcess() — terminate the running process
 * - isProcessAlive() — check if a process is currently running
 * - writeToStdin(content) — write a user message to stdin
 * - installHooksImpl() — install AskUserQuestion hooks
 */

import { DurableStream } from "@durable-streams/client"
import type { EngineEvent } from "@electric-agent/protocol"
import { ts } from "@electric-agent/protocol"
import type { StreamConnectionInfo } from "../streams.js"
import { formatGateMessage } from "./gate-response.js"
import { createStreamJsonParser } from "./stream-json-parser.js"

type StreamJsonParser = ReturnType<typeof createStreamJsonParser>

import type { SessionBridge, StreamMessage } from "./types.js"

export interface ClaudeCodeBaseConfig {
	/** Initial prompt (the user's app description or task) */
	prompt: string
	/** Working directory inside the container/sprite */
	cwd: string
	/** Model to use (default: claude-sonnet-4-6) */
	model?: string
	/** Allowed tools (default: all standard tools) */
	allowedTools?: string[]
	/** Additional CLI flags */
	extraFlags?: string[]
	/** HMAC token for authenticating hook-event requests back to the studio */
	hookToken?: string
	/** Agent name — injected into assistant_message events for display */
	agentName?: string
}

export const DEFAULT_ALLOWED_TOOLS = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Glob",
	"Grep",
	"WebSearch",
	"TodoWrite",
	"AskUserQuestion",
	"Skill",
]

export abstract class ClaudeCodeBaseBridge implements SessionBridge {
	readonly sessionId: string
	protected readonly streamUrl: string
	protected readonly streamHeaders: Record<string, string>

	protected writer: DurableStream
	protected parser: StreamJsonParser = createStreamJsonParser()
	protected closed = false
	protected running = false
	protected hooksInstalled = false

	/** Claude Code session ID captured from stream-json system.init — used for --resume */
	protected claudeSessionId: string | null = null
	/** Whether the parser already emitted a session_end (from a "result" message) */
	protected resultReceived = false
	/** Whether the process was intentionally interrupted (suppress exit handler session_end) */
	protected interrupted = false
	/** Queued messages to deliver after the current process finishes */
	protected pendingMessages: string[] = []

	private agentEventCallbacks: Array<(event: EngineEvent) => void> = []
	private completeCallbacks: Array<(success: boolean) => void> = []

	/** Logging prefix for console output (e.g., "claude-code-docker") */
	protected abstract readonly logPrefix: string

	constructor(sessionId: string, connection: StreamConnectionInfo) {
		this.sessionId = sessionId
		this.streamUrl = connection.url
		this.streamHeaders = connection.headers

		this.writer = new DurableStream({
			url: connection.url,
			headers: connection.headers,
			contentType: "application/json",
		})
	}

	// -------------------------------------------------------------------
	// Abstract methods — implemented by Docker/Sprites subclasses
	// -------------------------------------------------------------------

	/** Spawn a new Claude Code process with the given prompt and optional resume session. */
	protected abstract spawnProcess(prompt: string, resumeSessionId?: string): void | Promise<void>

	/** Kill the currently running process. */
	protected abstract killProcess(): void

	/** Check if a process handle exists (not necessarily alive). */
	protected abstract hasProcess(): boolean

	/** Write a raw string to the process's stdin. */
	protected abstract writeToStdin(content: string): void

	/** Install AskUserQuestion hooks in the sandbox. */
	protected abstract installHooksImpl(): void | Promise<void>

	/** Get the agent name for event injection. */
	protected abstract getAgentName(): string | undefined

	// -------------------------------------------------------------------
	// SessionBridge interface
	// -------------------------------------------------------------------

	async emit(event: EngineEvent): Promise<void> {
		if (this.closed) return
		const msg: StreamMessage = { source: "server", ...event }
		await this.writer.append(JSON.stringify(msg))
	}

	/**
	 * Send a follow-up user message to Claude Code by respawning with --resume.
	 *
	 * If Claude Code is currently running, the message is queued and delivered
	 * after the current process finishes. This prevents killing the agent
	 * mid-work and losing in-flight file writes or tool calls.
	 */
	async sendCommand(cmd: Record<string, unknown>): Promise<void> {
		if (this.closed) return

		if (cmd.command === "iterate" && typeof cmd.request === "string") {
			if (this.running && this.hasProcess()) {
				console.log(
					`[${this.logPrefix}] Queuing message (agent busy): session=${this.sessionId} queue=${this.pendingMessages.length + 1}`,
				)
				this.pendingMessages.push(cmd.request)
				return
			}
			await this.spawnProcess(cmd.request, this.claudeSessionId ?? undefined)
			return
		}

		console.log(`[${this.logPrefix}] Ignoring unsupported command: ${cmd.command}`)
	}

	async sendGateResponse(gate: string, value: Record<string, unknown>): Promise<void> {
		if (this.closed || !this.hasProcess()) return
		const message = formatGateMessage(gate, value)
		if (message != null) {
			this.writeUserMessage(message)
		}
	}

	onAgentEvent(cb: (event: EngineEvent) => void): void {
		this.agentEventCallbacks.push(cb)
	}

	onComplete(cb: (success: boolean) => void): void {
		this.completeCallbacks.push(cb)
	}

	abstract start(): Promise<void>

	isRunning(): boolean {
		return this.running
	}

	interrupt(): void {
		this.interrupted = true
		this.killProcess()
		this.running = false
	}

	close(): void {
		this.closed = true
		this.killProcess()
	}

	// -------------------------------------------------------------------
	// Shared helpers — used by subclasses
	// -------------------------------------------------------------------

	/**
	 * Reset parser state before spawning a new process.
	 * Call this at the start of spawnProcess implementations.
	 */
	protected resetParserState(): void {
		this.parser = createStreamJsonParser()
		this.resultReceived = false
		this.interrupted = false
		this.running = true
	}

	/**
	 * Install hooks if not already installed.
	 * Call this at the start of spawnProcess implementations.
	 */
	protected async ensureHooksInstalled(): Promise<void> {
		if (!this.hooksInstalled) {
			try {
				await this.installHooksImpl()
				this.hooksInstalled = true
			} catch (err) {
				console.error(`[${this.logPrefix}] Hook install error:`, err)
			}
		}
	}

	/**
	 * Handle a line of NDJSON output from Claude Code.
	 * Call this from stdout readline handlers.
	 */
	protected handleLine(line: string): void {
		const trimmed = line.trim()
		if (!trimmed) return

		const events = this.parser.parse(trimmed)
		for (const event of events) {
			this.dispatchEvent(event)
		}
	}

	/**
	 * Handle process exit. Call this from process exit handlers.
	 * Defers processing to let pending readline events flush first.
	 */
	protected handleProcessExit(code: number | null): void {
		console.log(`[${this.logPrefix}] Process exited: code=${code} session=${this.sessionId}`)
		setTimeout(() => {
			if (this.parser.state.sessionId) {
				this.claudeSessionId = this.parser.state.sessionId
			}
			this.running = false

			// Drain pending messages — if messages were queued while the agent
			// was busy, combine them and respawn with --resume so the agent
			// continues from where it left off instead of losing context.
			if (!this.closed && this.pendingMessages.length > 0) {
				const combined = this.pendingMessages.join("\n\n---\n\n")
				this.pendingMessages = []
				console.log(`[${this.logPrefix}] Draining queued messages: session=${this.sessionId}`)
				this.spawnProcess(combined, this.claudeSessionId ?? undefined)
				return
			}

			// Only emit session_end from exit handler if the parser didn't already
			// emit one (via a "result" message) and the process wasn't intentionally
			// interrupted. This prevents double session_end.
			if (!this.closed && !this.resultReceived && !this.interrupted) {
				const endEvent: EngineEvent = {
					type: "session_end",
					success: code === 0,
					ts: ts(),
				}
				this.dispatchEvent(endEvent)
			}
		}, 100)
	}

	/**
	 * Dispatch an engine event to the durable stream and all callbacks.
	 */
	protected dispatchEvent(event: EngineEvent): void {
		// Inject agent name into assistant_message events for display
		const agentName = this.getAgentName()
		if (agentName && event.type === "assistant_message") {
			;(event as EngineEvent & { agent?: string }).agent = agentName
		}

		// Write to Durable Stream for UI
		const msg: StreamMessage = { source: "agent", ...event }
		this.writer.append(JSON.stringify(msg)).catch(() => {})

		// Track session_end from result messages to prevent duplicates
		if (event.type === "session_end") {
			this.resultReceived = true
		}

		// Detect dev:start in Bash tool_use → emit app_status for the UI preview
		if (event.type === "pre_tool_use" && event.tool_name === "Bash") {
			const cmd = (event.tool_input as Record<string, unknown>)?.command
			if (typeof cmd === "string" && /\bdev:start\b/.test(cmd)) {
				const appStatus: EngineEvent = {
					type: "app_status",
					status: "running",
					ts: ts(),
				}
				const appStatusMsg: StreamMessage = { source: "agent", ...appStatus }
				this.writer.append(JSON.stringify(appStatusMsg)).catch(() => {})
				for (const cb of this.agentEventCallbacks) {
					try {
						cb(appStatus)
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

	/**
	 * Write a user message to Claude Code's stdin in stream-json format.
	 */
	private writeUserMessage(content: string): void {
		const msg = JSON.stringify({
			type: "user",
			message: { role: "user", content },
		})
		this.writeToStdin(`${msg}\n`)
	}
}
