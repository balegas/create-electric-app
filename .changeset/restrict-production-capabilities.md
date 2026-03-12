---
"@electric-agent/protocol": minor
"@electric-agent/studio": minor
---

Add production mode restrictions to prevent abuse during public events.

- Disable freeform sessions in production mode (!devMode)
- Remove WebSearch from allowed tools in production
- Add production guardrails to generated CLAUDE.md
- Enforce per-session cost budget ($5 default, configurable via MAX_SESSION_COST_USD)
- Add per-IP rate limiting on session creation (5/hour default, configurable via MAX_SESSIONS_PER_IP_PER_HOUR)
- Hardcode model to claude-sonnet-4-6 in production
- Add budget_exceeded protocol event with client-side display
- Expose /api/config endpoint for client feature flags
