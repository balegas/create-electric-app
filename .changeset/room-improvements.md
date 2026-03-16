---
"@electric-agent/studio": minor
"@electric-agent/protocol": patch
"@electric-agent/agent": patch
---

Room improvements: fix review loop, remove per-agent gating, update messaging

- Fix coder-reviewer infinite loop: coder skill now distinguishes REVIEW_FEEDBACK from APPROVED, room router auto-closes on APPROVED, maxRounds enforced
- Remove per-agent `gated` option from addParticipant and UI (GATE: prefix for human input still works)
- Update "local-first" references to "reactive, real-time" to match Electric SQL's current positioning
- UI designer skill uses AskUserQuestion with multiSelect for presenting improvement suggestions
