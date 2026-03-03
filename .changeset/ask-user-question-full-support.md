---
"@electric-agent/protocol": minor
"@electric-agent/studio": minor
"@electric-agent/agent": patch
---

Support full AskUserQuestion capabilities: multiSelect, multiple questions, and headers

- Add `AskUserQuestionItem` interface and `questions` field to the `ask_user_question` protocol event
- Pass through full `questions` array (with `header`, `multiSelect`) from Claude Code stream-json and hook events
- Rewrite `AskUserQuestionGate` UI to render multiple questions, multiSelect checkboxes, and header chips
- Extract duplicated `sendGateResponse()` logic from Docker and Sprites bridges into shared `formatGateMessage()` helper
- Switch gate resolution from single `answer` string to `answers: Record<string, string>` with backwards compat
- Update SKILL.md Phase 0 to be less prescriptive about clarification format
