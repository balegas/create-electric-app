#!/bin/bash
# Forward Claude Code hook events to the local web server.
#
# Session tracking uses Claude's own session_id (from SessionStart) to map
# Claude sessions → EA sessions. A temp file keyed by PPID stores the mapping.
# When Claude fires SessionStart with source=clear/resume (session switch),
# a new EA session is auto-created for the new Claude session.
#
# You can also set EA_SESSION_ID explicitly to pin to an existing EA session:
#   EA_SESSION_ID=<uuid> claude
#
# For AskUserQuestion events, the server blocks until the user answers in the
# web UI. The response contains hookSpecificOutput which is printed to stdout
# so Claude Code can read the answer.

EA_PORT="${EA_PORT:-4400}"
SESSION_DIR="/tmp/ea-sessions"
mkdir -p "$SESSION_DIR"

# Session mapping file: keyed by Claude Code PID (PPID of hook process)
MAPPING_FILE="${SESSION_DIR}/pid-${PPID}"

# Read stdin once
BODY="$(cat)"

# Extract hook_event_name and Claude's session_id from the JSON body
HOOK_NAME=$(echo "$BODY" | grep -o '"hook_event_name":"[^"]*"' | cut -d'"' -f4)
CLAUDE_SESSION_ID=$(echo "$BODY" | grep -o '"session_id":"[^"]*"' | cut -d'"' -f4)

# --- SessionStart handling ---
# SessionStart fires on: startup, clear, resume, compact
# Each time, we check if the Claude session_id changed → new EA session
if [ "$HOOK_NAME" = "SessionStart" ]; then
  NEED_NEW_SESSION=false

  if [ -n "$EA_SESSION_ID" ]; then
    # Explicit EA_SESSION_ID set — always use it, don't auto-create
    # Just forward the event
    :
  elif [ -f "$MAPPING_FILE" ]; then
    # Read the stored mapping: "claude_session_id ea_session_id"
    STORED_CLAUDE_ID=$(awk '{print $1}' "$MAPPING_FILE")
    STORED_EA_ID=$(awk '{print $2}' "$MAPPING_FILE")

    if [ "$CLAUDE_SESSION_ID" = "$STORED_CLAUDE_ID" ]; then
      # Same Claude session (compact) — reuse EA session
      EA_SESSION_ID="$STORED_EA_ID"
    else
      # Different Claude session (clear/resume) — need new EA session
      NEED_NEW_SESSION=true
    fi
  else
    # No mapping file yet (first startup) — need new session
    NEED_NEW_SESSION=true
  fi

  if [ "$NEED_NEW_SESSION" = true ]; then
    RESPONSE=$(curl -s -X POST "http://localhost:${EA_PORT}/api/sessions/auto" \
      -H "Content-Type: application/json" \
      -d "$BODY" \
      --max-time 5 \
      --connect-timeout 2 \
      2>/dev/null)

    NEW_EA_ID=$(echo "$RESPONSE" | grep -o '"sessionId":"[^"]*"' | cut -d'"' -f4)
    if [ -n "$NEW_EA_ID" ]; then
      echo "$CLAUDE_SESSION_ID $NEW_EA_ID" > "$MAPPING_FILE"
    fi
    exit 0  # SessionStart already emitted by /api/sessions/auto
  fi
fi

# --- Resolve EA_SESSION_ID for non-SessionStart events ---
if [ -z "$EA_SESSION_ID" ] && [ -f "$MAPPING_FILE" ]; then
  EA_SESSION_ID=$(awk '{print $2}' "$MAPPING_FILE")
fi

# No EA session → silently skip
if [ -z "$EA_SESSION_ID" ]; then
  exit 0
fi

# --- Forward the hook event ---
RESPONSE=$(curl -s -X POST "http://localhost:${EA_PORT}/api/sessions/${EA_SESSION_ID}/hook-event" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  --max-time 360 \
  --connect-timeout 2 \
  2>/dev/null)

# If the response contains hookSpecificOutput, print it so Claude Code reads it
if echo "$RESPONSE" | grep -q '"hookSpecificOutput"'; then
  echo "$RESPONSE"
fi

# On SessionEnd, clean up the mapping file
if [ "$HOOK_NAME" = "SessionEnd" ]; then
  rm -f "$MAPPING_FILE"
fi

exit 0  # Never block Claude Code
