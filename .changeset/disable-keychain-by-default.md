---
"@electric-agent/studio": patch
---

Disable `/api/credentials/keychain` endpoint by default. It now requires explicit opt-in via `devMode: true` or `STUDIO_DEV_MODE=1` env var to prevent exposing OAuth tokens in non-development environments.
