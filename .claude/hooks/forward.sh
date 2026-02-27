#!/bin/bash
# Forward Claude Code hook events to Electric Agent studio.
# The server correlates sessions via transcript_path (stable across resume/compact).
# Install: curl -s http://localhost:4400/api/hooks/setup | bash

EA_PORT="${EA_PORT:-4400}"
BODY="$(cat)"

RESPONSE=$(curl -s -X POST "http://localhost:${EA_PORT}/api/hook" \
  -H "Content-Type: application/json" \
  -d "${BODY}" \
  --max-time 360 \
  --connect-timeout 2 \
  2>/dev/null)

# If the response contains hookSpecificOutput, print it so Claude Code reads it
if echo "${RESPONSE}" | grep -q '"hookSpecificOutput"'; then
  echo "${RESPONSE}"
fi

exit 0
