# @electric-agent/studio

## 1.1.0

### Minor Changes

- 89d4cb6: Add Claude Code CLI bridge mode for interactive sandbox sessions

  - New `stream-json-parser` translates Claude Code's NDJSON output into EngineEvents for the existing Durable Streams pipeline
  - New `ClaudeCodeDockerBridge` and `ClaudeCodeSpritesBridge` spawn `claude` CLI with `--output-format stream-json` inside sandboxes
  - New `generateClaudeMd()` produces workspace CLAUDE.md with scaffold structure, guardrails, and playbook instructions
  - Per-session agent mode toggle (`claude-code` / `electric-agent`) stored in SessionInfo, with UI settings defaulting to Claude Code
  - Sprites bootstrap now installs `@anthropic-ai/claude-code` CLI globally
  - Gate responses (ask_user_question, clarification, approval) forwarded as user messages to Claude Code's stdin

- ba8f908: Add unified hook endpoint with transcript_path correlation for Claude Code integration

  - New `POST /api/hook` endpoint that uses `transcript_path` from Claude Code hook events as a stable correlation key, replacing PID-based session tracking
  - New `GET /api/hooks/setup` installer endpoint for project-scoped hook setup
  - Registry now stores `session_mapped` events to durably map transcript paths to sessions (survives server restarts)
  - Simplified `forward.sh` from ~100 lines to ~20 lines (just curl + print hookSpecificOutput)
  - Resume correctly reuses the same EA session instead of creating duplicates
  - Race condition guard prevents duplicate sessions from concurrent hook events

### Patch Changes

- fixes to sprites

## 1.0.0

### Major Changes

- e494542: restructured

### Minor Changes

- 9d0e4a0: monorepo
- a5c4703: Convert to pnpm workspaces monorepo with three packages: protocol, studio, and agent

### Patch Changes

- Updated dependencies [9d0e4a0]
- Updated dependencies [a5c4703]
- Updated dependencies [e494542]
  - @electric-agent/protocol@1.0.0
