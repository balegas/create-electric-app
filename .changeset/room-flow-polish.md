---
"@electric-agent/studio": patch
---

Room flow polish: conditional reviewer and UI refinements

- Only add reviewer agent when a GitHub repo is configured (GitHub App or user-selected repo)
- Dashed underline only on inline agent name links in system messages, not on [name] prefix
- Align agent name with first line in collapsible messages, use normal text color
- Indent tail tool calls under collapsed group header
