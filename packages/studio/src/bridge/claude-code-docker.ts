/**
 * SessionBridge implementation that runs Claude Code CLI inside a Docker
 * container via `docker exec -i`, communicating via stream-json NDJSON.
 *
 * The bridge translates Claude Code's stream-json output into EngineEvents
 * and writes them to the Durable Stream for the UI. User messages and
 * gate responses are sent to Claude Code's stdin.
 */

import { type ChildProcess, spawn } from "node:child_process"
import * as readline from "node:readline"
import { DurableStream } from "@durable-streams/client"
import type { EngineEvent } from "@electric-agent/protocol"
import { ts } from "@electric-agent/protocol"
import type { StreamConnectionInfo } from "../streams.js"
import { createStreamJsonParser } from "./stream-json-parser.js"
import type { SessionBridge, StreamMessage } from "./types.js"

export interface ClaudeCodeDockerConfig {
	/** Initial prompt (the user's app description or task) */
	prompt: string
	/** Working directory inside the container */
	cwd: string
	/** Model to use (default: claude-sonnet-4-6) */
	model?: string
	/** Allowed tools (default: all standard tools) */
	allowedTools?: string[]
	/** Additional CLI flags */
	extraFlags?: string[]
}

const DEFAULT_ALLOWED_TOOLS = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Glob",
	"Grep",
	"WebSearch",
	"TodoWrite",
	"AskUserQuestion",
]

export class ClaudeCodeDockerBridge implements SessionBridge {
	readonly sessionId: string
	readonly streamUrl: string
	readonly streamHeaders: Record<string, string>

	private containerId: string
	private config: ClaudeCodeDockerConfig
	private writer: DurableStream
	private parser = createStreamJsonParser()
	private agentEventCallbacks: Array<(event: EngineEvent) => void> = []
	private completeCallbacks: Array<(success: boolean) => void> = []
	private closed = false
	private proc: ChildProcess | null = null

	constructor(
		sessionId: string,
		connection: StreamConnectionInfo,
		containerId: string,
		config: ClaudeCodeDockerConfig,
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
	 * Send a follow-up user message to Claude Code via stdin.
	 * Used for iteration requests (the user types a new message in the UI).
	 */
	async sendCommand(cmd: Record<string, unknown>): Promise<void> {
		if (this.closed || !this.proc?.stdin?.writable) return

		// For iteration: send the request as a user message to Claude Code's stdin
		if (cmd.command === "iterate" && typeof cmd.request === "string") {
			this.writeUserMessage(cmd.request)
			return
		}

		// For initial "new" command: this is handled in start() via the prompt
		// Other commands are ignored — Claude Code doesn't understand them
		console.log(`[claude-code-docker] Ignoring unsupported command: ${cmd.command}`)
	}

	/**
	 * Send a gate response back to Claude Code as a user message.
	 * For ask_user_question gates, the user's answer becomes a follow-up message.
	 */
	async sendGateResponse(gate: string, value: Record<string, unknown>): Promise<void> {
		if (this.closed || !this.proc?.stdin?.writable) return

		if (gate === "ask_user_question" || gate.startsWith("ask_user_question:")) {
			const answer = (value.answer as string) || ""
			this.writeUserMessage(answer)
			return
		}

		if (gate === "clarification") {
			const answers = value.answers as string[] | undefined
			if (answers?.length) {
				this.writeUserMessage(answers.join("\n"))
			}
			return
		}

		if (gate === "approval") {
			const decision = (value.decision as string) || "approve"
			this.writeUserMessage(decision)
			return
		}

		if (gate === "continue") {
			const proceed = value.proceed as boolean
			this.writeUserMessage(proceed ? "continue" : "stop")
			return
		}

		// Generic: send the value as JSON
		this.writeUserMessage(JSON.stringify(value))
	}

	onAgentEvent(cb: (event: EngineEvent) => void): void {
		this.agentEventCallbacks.push(cb)
	}

	onComplete(cb: (success: boolean) => void): void {
		this.completeCallbacks.push(cb)
	}

	async start(): Promise<void> {
		if (this.closed) return

		const allowedTools = this.config.allowedTools ?? DEFAULT_ALLOWED_TOOLS
		const model = this.config.model ?? "claude-sonnet-4-6"

		// Build the claude CLI command
		const claudeArgs = [
			"-p",
			this.config.prompt,
			"--output-format",
			"stream-json",
			"--verbose",
			"--model",
			model,
			"--dangerously-skip-permissions",
			"--allowedTools",
			allowedTools.join(","),
			...(this.config.extraFlags ?? []),
		]

		// Escape for bash
		const escapedArgs = claudeArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")
		const cmd = `cd '${this.config.cwd}' && claude ${escapedArgs}`

		// Note: do NOT use -i flag — Claude Code detects interactive stdin and blocks
		// waiting for input even when -p is provided. Without -i, stdout flows normally.
		this.proc = spawn("docker", ["exec", this.containerId, "bash", "-c", cmd], {
			stdio: ["pipe", "pipe", "pipe"],
		})

		console.log(
			`[claude-code-docker] Started: session=${this.sessionId} container=${this.containerId} pid=${this.proc.pid}`,
		)
		console.log(`[claude-code-docker] cmd: ${cmd}`)

		// Read stdout line by line (stream-json NDJSON)
		if (this.proc.stdout) {
			const rl = readline.createInterface({
				input: this.proc.stdout,
				terminal: false,
			})

			rl.on("line", (line) => {
				if (this.closed) return
				console.log(`[claude-code-docker:stdout] ${line.slice(0, 120)}...`)
				this.handleLine(line)
			})
		}

		// Log stderr
		if (this.proc.stderr) {
			const stderrRl = readline.createInterface({
				input: this.proc.stderr,
				terminal: false,
			})
			stderrRl.on("line", (line) => {
				if (!this.closed) {
					console.error(`[claude-code-docker:stderr] ${line}`)
				}
			})
		}

		// Handle process exit
		this.proc.on("exit", (code) => {
			console.log(`[claude-code-docker] Process exited: code=${code} session=${this.sessionId}`)
			// If process exits without a session_end event, emit one
			if (!this.closed) {
				const endEvent: EngineEvent = {
					type: "session_end",
					success: code === 0,
					ts: ts(),
				}
				this.dispatchEvent(endEvent)
			}
		})
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

	/**
	 * Write a user message to Claude Code's stdin in stream-json format.
	 */
	private writeUserMessage(content: string): void {
		if (!this.proc?.stdin?.writable) return
		const msg = JSON.stringify({
			type: "user",
			message: { role: "user", content },
		})
		this.proc.stdin.write(`${msg}\n`)
	}
}
