---
"@electric-agent/studio": minor
---

Add unified hook endpoint with transcript_path correlation for Claude Code integration

- New `POST /api/hook` endpoint that uses `transcript_path` from Claude Code hook events as a stable correlation key, replacing PID-based session tracking
- New `GET /api/hooks/setup` installer endpoint for project-scoped hook setup
- Registry now stores `session_mapped` events to durably map transcript paths to sessions (survives server restarts)
- Simplified `forward.sh` from ~100 lines to ~20 lines (just curl + print hookSpecificOutput)
- Resume correctly reuses the same EA session instead of creating duplicates
- Race condition guard prevents duplicate sessions from concurrent hook events
