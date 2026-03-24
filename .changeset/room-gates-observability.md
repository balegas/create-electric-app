---
"@electric-agent/studio": patch
"@electric-agent/protocol": patch
"@electric-agent/agent": patch
---

Room gates, observability, and headless create command

- Room-level gate respond endpoint (POST /rooms/:id/respond) with room token auth
- Join API returns session tokens for all agents in the room
- Room state polling auto-discovers agents and stores tokens
- Forward ask_user_question and gate_resolved to room stream as agent_activity
- Derive resolved gate state from durable stream (survives refresh)
- Reuse AskUserQuestionGate component in both agent and room views
- Show agent name with session link on room gate questions
- Headless `electric-agent create` command with --local flag
- Auto-join room via ?code= query parameter
- Guard TodoWidget against non-array todos
- Fix gate duplication, back-to-room styling, select theming
