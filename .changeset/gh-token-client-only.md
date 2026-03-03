---
"@electric-agent/studio": patch
---

Make GitHub token client-side only — server-side git functions now require an explicit token parameter and never fall back to ambient GH_TOKEN environment variable.
