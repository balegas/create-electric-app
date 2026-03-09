---
"@electric-agent/studio": minor
"@electric-agent/protocol": patch
---

Add role-based skills for agent rooms and multiple room UX improvements.

**Role skills:**
- Built-in `coder` and `reviewer` roles with skill files defining workflows, interaction protocols, and boundaries
- Role-specific tool permissions: reviewer is read-only (no Write/Edit), coder has full access
- Role selector dropdown in the Add Agent modal (replaces freeform text input)
- Role skill files are injected into agent sandboxes alongside the room-messaging skill

**Room improvements:**
- Room-messaging skill is now injected into room agent sandboxes (was missing)
- Fix regex lastIndex bug in message parser that caused agents to miss @room messages
- Initial prompts sent only to the target agent (no longer broadcast to all)
- Rooms no longer auto-close on DONE: or max rounds — only manual close via UI
- Agent join/leave events broadcast to other participants' session streams
- Participant avatars in room header (clickable, navigate to agent session)
- Agent names in room messages are clickable links to their sessions
- Room messages appear in agent session streams with sender label ([reviewer] instead of [you])
- Removed "Direct message to session" section (redundant with room prompt input)
- Session sidebar uses deterministic ordering (createdAt instead of lastActiveAt)
- Reviewer skill instructs posting PR summary comment when review is complete
- Room-messaging skill updated to encourage message acknowledgment
