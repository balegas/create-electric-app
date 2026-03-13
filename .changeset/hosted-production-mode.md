---
"@electric-agent/studio": minor
"@electric-agent/agent": patch
---

Add hosted production mode with server-side Claude API key, rate limiting (global session cap, per-IP limits, per-session cost budget), GitHub App integration for automatic repo creation under electric-apps org, git credential helper for transparent token management in sandboxes, and random slug naming for prod repos. Dev mode retains full credential UI and no rate limits. Agent template updated with README writing step in create-app skill.
