---
"electric-agent": minor
---

Align EngineEvent protocol with Claude Code hooks and add local session bridge

- Rename event types and fields to match Claude Code hook vocabulary (pre_tool_use, post_tool_use, session_start, session_end, etc.)
- Add hook-to-stream bridge for local Claude Code sessions via forward.sh hook script
- Add POST /api/sessions/local and POST /api/sessions/:id/hook-event endpoints
- Fix waiting indicator to dismiss after Stop hook
