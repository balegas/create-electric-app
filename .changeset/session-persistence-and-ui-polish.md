---
"@electric-agent/studio": minor
---

Session persistence, bridge resurrection, and UI polish

- Persist sessions across server restarts via durable stream Registry
- Reconnect Docker containers on startup (match running containers to sessions)
- Recreate ClaudeCodeDockerBridge on iterate after restart (fixes agent not responding)
- Consistent room container naming: all agents use `room-{name}-{id}` prefix
- Add needsInput flag with orange avatar ring on sidebar when agent awaits user input
- Emit room messages on gate resolve ("received input — resuming")
- Fix GatePrompt crash (Array.isArray guard for questions)
- Fix "is working" indicator shown when agent is waiting for input
- Switch all fonts from monospace to sans-serif (OpenSauceOne)
- Remove bold fonts from avatars
