#!/bin/bash
# Forward Claude Code hook events to the local web server.
#
# Usage:
#   1. Start the web server: npm run serve
#   2. Create a local session:
#        SESSION_ID=$(curl -s -X POST http://localhost:4400/api/sessions/local \
#          -H "Content-Type: application/json" \
#          -d '{"description":"my session"}' | jq -r .sessionId)
#   3. Export the session ID and start Claude Code:
#        EA_SESSION_ID=$SESSION_ID claude
#
# Claude Code passes hook data as JSON on stdin. This script reads it and
# POSTs it to the web server's hook-event endpoint.
#
# For AskUserQuestion events, the server blocks until the user answers in the
# web UI. The response contains hookSpecificOutput which is printed to stdout
# so Claude Code can read the answer.

if [ -z "$EA_SESSION_ID" ]; then
  exit 0  # No session — silently skip
fi

EA_PORT="${EA_PORT:-4400}"

RESPONSE=$(curl -s -X POST "http://localhost:${EA_PORT}/api/sessions/${EA_SESSION_ID}/hook-event" \
  -H "Content-Type: application/json" \
  -d "$(cat)" \
  --max-time 360 \
  --connect-timeout 2 \
  2>/dev/null)

# If the response contains hookSpecificOutput, print it so Claude Code reads it
if echo "$RESPONSE" | grep -q '"hookSpecificOutput"'; then
  echo "$RESPONSE"
fi

exit 0  # Never block Claude Code
