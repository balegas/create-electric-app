---
"@electric-agent/studio": patch
---

Fix Claude Code bridge in Sprites sandboxes

- Fix bootstrap to install `@electric-agent/agent` (scoped) instead of legacy `electric-agent` package
- Use SpriteCommand with tty:true but without detachable/tmux to fix immediate exit
- Strip ANSI escape sequences from tty output before parsing stream-json NDJSON
