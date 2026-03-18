---
"@electric-agent/studio": minor
---

Clean up room → agent creation flow and improve room UI

- Remove dead room code from Registry (renamed to SessionRegistry)
- Clean up console log messages with consistent prefixes
- Simplify room timeline messages and show infra config as inline card
- Fix duplicate reviewer announcements via skipDiscovery option
- Add agent name colors and clickable links in room timeline
- Right-align timestamps in room view to match agent view
- Add room link in agent session header for navigation
- Enable GitHub org/repo selector when user provides a PAT (any mode)
- Remove devMode gate from GitHub API endpoints (token-gated instead)
- Remove generic participant role from Add Agent modal
- Add room-flow.test.ts with 24 integration tests
