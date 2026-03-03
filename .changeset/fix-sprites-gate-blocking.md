---
"@electric-agent/studio": patch
---

fix: disable TTY mode in sprites bridge so AskUserQuestion gates block properly

Switching SpriteCommand from `tty: true` to no-TTY mode prevents PTY from merging stdout/stderr and corrupting hook response JSON. This matches the Docker bridge behavior where pipes cleanly separate streams.
