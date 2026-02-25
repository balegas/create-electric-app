#!/bin/bash
# Setup Claude Code hooks to forward events to the Electric Agent web UI.
#
# Usage:
#   ./scripts/setup-hooks.sh [settings-file]
#
# Arguments:
#   settings-file  Path to a Claude Code settings JSON file.
#                  Defaults to ~/.claude/settings.json (global).
#                  Examples:
#                    ~/.claude/settings.json          — global (all projects)
#                    .claude/settings.local.json      — project-local
#
# What it does:
#   1. Copies forward.sh to ~/.claude/hooks/ea-forward.sh (stable location)
#   2. Adds hook entries for all supported events to the settings file
#   3. Idempotent — safe to run multiple times

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FORWARD_SRC="${PROJECT_DIR}/.claude/hooks/forward.sh"

# Target settings file
SETTINGS_FILE="${1:-${HOME}/.claude/settings.json}"

# Install location for the forwarding script
HOOKS_DIR="${HOME}/.claude/hooks"
FORWARD_DST="${HOOKS_DIR}/ea-forward.sh"

echo "Electric Agent — Claude Code hooks setup"
echo "========================================="
echo ""
echo "  Forward script: ${FORWARD_DST}"
echo "  Settings file:  ${SETTINGS_FILE}"
echo ""

# 1. Install forward.sh
mkdir -p "$HOOKS_DIR"
cp "$FORWARD_SRC" "$FORWARD_DST"
chmod +x "$FORWARD_DST"
echo "[✓] Installed ea-forward.sh → ${FORWARD_DST}"

# 2. Add hook entries to settings file
# Create the file if it doesn't exist
if [ ! -f "$SETTINGS_FILE" ]; then
  mkdir -p "$(dirname "$SETTINGS_FILE")"
  echo '{}' > "$SETTINGS_FILE"
  echo "[✓] Created ${SETTINGS_FILE}"
fi

# Use node (available since we're in a node project) to merge hooks
node -e "
const fs = require('fs');
const path = require('path');

const settingsPath = process.argv[1];
const hookCommand = process.argv[2];

const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

if (!settings.hooks) settings.hooks = {};

const hookEvents = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'Stop',
  'SessionEnd',
];

let added = 0;
let skipped = 0;

for (const event of hookEvents) {
  if (!settings.hooks[event]) settings.hooks[event] = [];

  // Check if we already have an ea-forward.sh hook
  const existing = settings.hooks[event].find(entry =>
    entry.hooks?.some(h => h.command?.includes('ea-forward.sh'))
  );

  if (existing) {
    skipped++;
    continue;
  }

  settings.hooks[event].push({
    matcher: '',
    hooks: [{ type: 'command', command: hookCommand }],
  });
  added++;
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
console.log('[✓] Hooks updated: ' + added + ' added, ' + skipped + ' already present');
" "$SETTINGS_FILE" "$FORWARD_DST"

echo ""
echo "Done! To use:"
echo "  1. Start the server:  npm run serve  (in the electric-agent project)"
echo "  2. Run Claude:        claude          (in any project)"
echo "  3. Open the web UI:   http://localhost:4400"
echo ""
echo "Sessions auto-register on first hook event. No manual setup needed."
