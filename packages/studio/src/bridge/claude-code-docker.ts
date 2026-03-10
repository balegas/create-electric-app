/**
 * SessionBridge implementation that runs Claude Code CLI inside a Docker
 * container via `docker exec`, communicating via stream-json NDJSON.
 *
 * Extends ClaudeCodeBaseBridge with Docker-specific process management
 * (spawn via `docker exec`, ChildProcess lifecycle, Docker hook installation).
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import * as readline from "node:readline"
import type { StreamConnectionInfo } from "../streams.js"
import {
	ClaudeCodeBaseBridge,
	type ClaudeCodeBaseConfig,
	DEFAULT_ALLOWED_TOOLS,
} from "./claude-code-base.js"

export interface ClaudeCodeDockerConfig extends ClaudeCodeBaseConfig {
	/** Studio server port — used to set up AskUserQuestion hooks inside the container */
	studioPort?: number
}

export class ClaudeCodeDockerBridge extends ClaudeCodeBaseBridge {
	protected readonly logPrefix = "claude-code-docker"

	private containerId: string
	private config: ClaudeCodeDockerConfig
	private proc: ChildProcess | null = null

	constructor(
		sessionId: string,
		connection: StreamConnectionInfo,
		containerId: string,
		config: ClaudeCodeDockerConfig,
	) {
		super(sessionId, connection)
		this.containerId = containerId
		this.config = config
	}

	async start(): Promise<void> {
		if (this.closed) return
		this.spawnProcess(this.config.prompt)
	}

	// -------------------------------------------------------------------
	// Abstract method implementations
	// -------------------------------------------------------------------

	protected spawnProcess(prompt: string, resumeSessionId?: string): void {
		// Kill any existing process
		this.killProcess()

		// Install hooks on first spawn (they persist for resume spawns)
		if (!this.hooksInstalled) {
			this.installHooksImpl()
			this.hooksInstalled = true
		}

		// Reset parser state for the new process
		this.resetParserState()

		const model = this.config.model ?? "claude-sonnet-4-6"
		const allowedTools = this.config.allowedTools ?? DEFAULT_ALLOWED_TOOLS
		const claudeArgs = [
			"-p",
			prompt,
			"--output-format",
			"stream-json",
			"--verbose",
			"--model",
			model,
			...(this.hooksInstalled
				? ["--allowedTools", allowedTools.join(",")]
				: ["--dangerously-skip-permissions"]),
			...(this.config.extraFlags ?? []),
		]

		if (resumeSessionId) {
			claudeArgs.push("--resume", resumeSessionId)
		}

		const escapedArgs = claudeArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")
		const cmd = `cd '${this.config.cwd}' && claude ${escapedArgs}`

		this.proc = spawn("docker", ["exec", this.containerId, "bash", "-c", cmd], {
			stdio: ["pipe", "pipe", "pipe"],
		})

		console.log(
			`[claude-code-docker] Started: session=${this.sessionId} container=${this.containerId} pid=${this.proc.pid} resume=${resumeSessionId ?? "none"}`,
		)
		console.log(`[claude-code-docker] cmd: ${cmd}`)

		const currentProc = this.proc

		if (currentProc.stdout) {
			const rl = readline.createInterface({
				input: currentProc.stdout,
				terminal: false,
			})
			rl.on("line", (line) => {
				if (this.closed) return
				console.log(`[claude-code-docker:stdout] ${line.slice(0, 120)}...`)
				this.handleLine(line)
			})
		}

		if (currentProc.stderr) {
			const stderrRl = readline.createInterface({
				input: currentProc.stderr,
				terminal: false,
			})
			stderrRl.on("line", (line) => {
				if (!this.closed) {
					console.error(`[claude-code-docker:stderr] ${line}`)
				}
			})
		}

		currentProc.on("exit", (code) => {
			this.handleProcessExit(code)
		})
	}

	protected killProcess(): void {
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

	protected hasProcess(): boolean {
		return this.proc != null
	}

	protected writeToStdin(content: string): void {
		if (this.proc?.stdin?.writable) {
			this.proc.stdin.write(content)
		}
	}

	protected getAgentName(): string | undefined {
		return this.config.agentName
	}

	// -------------------------------------------------------------------
	// Docker-specific hook installation
	// -------------------------------------------------------------------

	protected installHooksImpl(): void {
		const port = this.config.studioPort
		if (!port) return

		const hookDir = `${this.config.cwd}/.claude/hooks`
		const settingsFile = `${this.config.cwd}/.claude/settings.local.json`
		const studioUrl = `http://host.docker.internal:${port}`

		const hookToken = this.config.hookToken ?? ""
		const forwardScript = `#!/bin/bash
# Forward AskUserQuestion hook events to Electric Agent studio.
# Blocks until the user answers in the web UI.
BODY="$(cat)"
RESPONSE=$(curl -s -X POST "${studioUrl}/api/sessions/${this.sessionId}/hook-event" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${hookToken}" \\
  -d "\${BODY}" \\
  --max-time 360 \\
  --connect-timeout 5 \\
  2>/dev/null)
if echo "\${RESPONSE}" | grep -q '"hookSpecificOutput"'; then
  echo "\${RESPONSE}"
fi
exit 0`

		const settings = JSON.stringify({
			hooks: {
				PreToolUse: [
					{
						matcher: "AskUserQuestion",
						hooks: [
							{
								type: "command",
								command: `${hookDir}/forward.sh`,
							},
						],
					},
				],
			},
		})

		try {
			const forwardB64 = Buffer.from(forwardScript).toString("base64")
			const settingsB64 = Buffer.from(settings).toString("base64")
			execFileSync("docker", [
				"exec",
				this.containerId,
				"bash",
				"-c",
				[
					`mkdir -p '${hookDir}'`,
					`echo '${forwardB64}' | base64 -d > '${hookDir}/forward.sh'`,
					`chmod +x '${hookDir}/forward.sh'`,
					`echo '${settingsB64}' | base64 -d > '${settingsFile}'`,
				].join(" && "),
			])
			console.log(`[claude-code-docker] Installed AskUserQuestion hooks in container`)
		} catch (err) {
			console.error(`[claude-code-docker] Failed to install hooks:`, err)
		}
	}
}
