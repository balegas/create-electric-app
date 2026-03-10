/**
 * SessionBridge implementation that runs Claude Code CLI inside a Sprites
 * sandbox via the Sprites SDK session API, communicating via stream-json NDJSON.
 *
 * Extends ClaudeCodeBaseBridge with Sprites-specific process management
 * (SpriteCommand lifecycle, TTY mode, ANSI stripping, Sprites hook installation).
 */

import * as readline from "node:readline"
import type { Sprite } from "@fly/sprites"
import { SpriteCommand } from "@fly/sprites"
import type { StreamConnectionInfo } from "../streams.js"
import {
	ClaudeCodeBaseBridge,
	type ClaudeCodeBaseConfig,
	DEFAULT_ALLOWED_TOOLS,
} from "./claude-code-base.js"

export interface ClaudeCodeSpritesConfig extends ClaudeCodeBaseConfig {
	/** Studio server URL — used to set up AskUserQuestion hooks inside the sprite */
	studioUrl?: string
}

export class ClaudeCodeSpritesBridge extends ClaudeCodeBaseBridge {
	protected readonly logPrefix = "claude-code-sprites"

	private sprite: Sprite
	private config: ClaudeCodeSpritesConfig
	private cmd: SpriteCommand | null = null

	constructor(
		sessionId: string,
		connection: StreamConnectionInfo,
		sprite: Sprite,
		config: ClaudeCodeSpritesConfig,
	) {
		super(sessionId, connection)
		this.sprite = sprite
		this.config = config
	}

	async start(): Promise<void> {
		if (this.closed) return
		await this.spawnProcess(this.config.prompt)
	}

	// -------------------------------------------------------------------
	// Abstract method implementations
	// -------------------------------------------------------------------

	protected async spawnProcess(prompt: string, resumeSessionId?: string): Promise<void> {
		// Kill any existing process
		this.killProcess()

		// Install hooks on first spawn — must await for sprites
		await this.ensureHooksInstalled()

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
		const fullCmd = `source /etc/profile.d/npm-global.sh 2>/dev/null; source /etc/profile.d/electric-agent.sh 2>/dev/null; cd '${this.config.cwd}' && claude ${escapedArgs}`

		// Use SpriteCommand with tty:true — Claude Code requires a TTY to produce
		// stream-json output in sprites (non-TTY mode results in zero stdout).
		// Do NOT use detachable (creates a tmux session causing immediate exit).
		this.cmd = new SpriteCommand(this.sprite, "bash", ["-c", fullCmd], {
			tty: true,
		})
		this.cmd.start()

		console.log(
			`[claude-code-sprites] Started: session=${this.sessionId} resume=${resumeSessionId ?? "none"}`,
		)

		const currentCmd = this.cmd

		// Read stdout line by line (stream-json NDJSON)
		const rl = readline.createInterface({
			input: currentCmd.stdout,
			terminal: false,
		})
		rl.on("line", (line) => {
			if (this.closed) return
			// Strip ANSI escape sequences added by TTY mode before parsing
			const cleaned = stripAnsi(line).trim()
			if (!cleaned) return
			this.handleLine(cleaned)
		})

		// Log stderr
		const stderrRl = readline.createInterface({
			input: currentCmd.stderr,
			terminal: false,
		})
		stderrRl.on("line", (line) => {
			if (!this.closed) {
				console.error(`[claude-code-sprites:stderr] ${line}`)
			}
		})

		currentCmd.on("exit", (code) => {
			this.handleProcessExit(code)
		})
	}

	protected killProcess(): void {
		if (this.cmd) {
			try {
				this.cmd.kill()
			} catch {
				// Process may already be dead
			}
			this.cmd = null
		}
	}

	protected hasProcess(): boolean {
		return this.cmd != null
	}

	protected writeToStdin(content: string): void {
		if (this.cmd) {
			this.cmd.stdin.write(content)
		}
	}

	protected getAgentName(): string | undefined {
		return this.config.agentName
	}

	// -------------------------------------------------------------------
	// Sprites-specific hook installation
	// -------------------------------------------------------------------

	protected async installHooksImpl(): Promise<void> {
		const studioUrl = this.config.studioUrl
		if (!studioUrl) return

		const hookDir = `${this.config.cwd}/.claude/hooks`
		const settingsFile = `${this.config.cwd}/.claude/settings.local.json`

		const hookToken = this.config.hookToken ?? ""
		const forwardScript = `#!/bin/bash
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
			await this.sprite.execFile("bash", [
				"-c",
				[
					`mkdir -p '${hookDir}'`,
					`echo '${forwardB64}' | base64 -d > '${hookDir}/forward.sh'`,
					`chmod +x '${hookDir}/forward.sh'`,
					`echo '${settingsB64}' | base64 -d > '${settingsFile}'`,
				].join(" && "),
			])
			console.log(`[claude-code-sprites] Installed AskUserQuestion hooks in sprite`)
		} catch (err) {
			console.error(`[claude-code-sprites] Failed to install hooks:`, err)
		}
	}
}

/** Strip ANSI escape sequences and control characters from tty output */
function stripAnsi(str: string): string {
	const ESC = "\x1b"
	const csi = new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, "g")
	const osc1 = new RegExp(`${ESC}\\][^\\x07]*\\x07`, "g")
	const osc2 = new RegExp(`${ESC}\\][^${ESC}]*${ESC}\\\\`, "g")
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip C0 control chars except \n \r
	const ctrl = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g
	return str.replace(csi, "").replace(osc1, "").replace(osc2, "").replace(ctrl, "")
}
