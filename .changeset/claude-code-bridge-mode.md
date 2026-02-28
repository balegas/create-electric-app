---
"@electric-agent/studio": minor
---

Add Claude Code CLI bridge mode for interactive sandbox sessions

- New `stream-json-parser` translates Claude Code's NDJSON output into EngineEvents for the existing Durable Streams pipeline
- New `ClaudeCodeDockerBridge` and `ClaudeCodeSpritesBridge` spawn `claude` CLI with `--output-format stream-json` inside sandboxes
- New `generateClaudeMd()` produces workspace CLAUDE.md with scaffold structure, guardrails, and playbook instructions
- Per-session agent mode toggle (`claude-code` / `electric-agent`) stored in SessionInfo, with UI settings defaulting to Claude Code
- Sprites bootstrap now installs `@anthropic-ai/claude-code` CLI globally
- Gate responses (ask_user_question, clarification, approval) forwarded as user messages to Claude Code's stdin
