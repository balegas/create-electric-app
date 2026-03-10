#!/bin/bash
# Wrapper script that starts Claude Code with Electric Agent session tracking.
#
# Usage:
#   ea-claude [claude-args...]
#
# Examples:
#   ea-claude                         # start claude in current directory
#   ea-claude --resume                # resume last conversation
#   ea-claude -p "fix the login bug"  # start with a prompt
#   ea-claude --model sonnet          # pass model flag
#
# What it does:
#   1. Checks the EA server is running (localhost:4400 by default)
#   2. Pre-creates a session via POST /api/sessions/auto with a synthetic
#      SessionStart so the session appears in the web UI immediately
#   3. Starts `claude` with EA_SESSION_ID set so all hooks forward to that session
#   4. On exit, sends SessionEnd to mark the session complete
#
# Environment:
#   EA_PORT          Server port (default: 4400)
#   EA_SESSION_ID    Skip auto-creation, attach to this existing session
#   EA_SERVER_URL    Full server URL (default: http://localhost:${EA_PORT})

set -euo pipefail

EA_PORT="${EA_PORT:-4400}"
EA_SERVER_URL="${EA_SERVER_URL:-http://localhost:${EA_PORT}}"

# --- Check server is running ---
if ! curl -sf "${EA_SERVER_URL}/api/health" --connect-timeout 2 >/dev/null 2>&1; then
  echo "⚠ Electric Agent server not running at ${EA_SERVER_URL}" >&2
  echo "  Start it with: npm run serve" >&2
  echo "  Continuing without session tracking..." >&2
  echo "" >&2
  exec claude "$@"
fi

# --- Create or reuse session ---
if [ -z "${EA_SESSION_ID:-}" ]; then
  CWD="$(pwd)"
  PROJECT_NAME="$(basename "$CWD")"

  RESPONSE=$(curl -sf -X POST "${EA_SERVER_URL}/api/sessions/auto" \
    -H "Content-Type: application/json" \
    -d "{
      \"hook_event_name\": \"SessionStart\",
      \"session_id\": \"ea-wrapper-$(date +%s)\",
      \"cwd\": \"${CWD}\",
      \"source\": \"startup\"
    }" \
    --max-time 5 \
    2>/dev/null) || true

  EA_SESSION_ID=$(echo "$RESPONSE" | grep -o '"sessionId":"[^"]*"' | cut -d'"' -f4)
  EA_HOOK_TOKEN=$(echo "$RESPONSE" | grep -o '"hookToken":"[^"]*"' | cut -d'"' -f4)

  if [ -n "$EA_SESSION_ID" ]; then
    echo "✓ Session: ${EA_SERVER_URL}/session/${EA_SESSION_ID}" >&2
  else
    echo "⚠ Failed to create session, continuing without tracking" >&2
    exec claude "$@"
  fi
fi

export EA_SESSION_ID
export EA_HOOK_TOKEN
export EA_PORT

# --- Cleanup on exit: send SessionEnd ---
cleanup() {
  if [ -n "${EA_SESSION_ID:-}" ]; then
    curl -sf -X POST "${EA_SERVER_URL}/api/sessions/${EA_SESSION_ID}/hook-event" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${EA_HOOK_TOKEN}" \
      -d '{"hook_event_name":"SessionEnd"}' \
      --max-time 2 \
      2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- Start Claude Code ---
exec claude "$@"
