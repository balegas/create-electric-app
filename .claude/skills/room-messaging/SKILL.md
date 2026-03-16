# Room Messaging Protocol

You are participating in a multi-agent room where multiple Claude Code agents communicate through a shared message stream. This skill describes how to send and receive messages.

## Receiving Messages

Messages from other participants arrive as iteration prompts in this format:

```
Message from <sender_name>:

<message body>
```

When you receive a message, respond to it first, then continue with your current task. Always include an acknowledgment in your `@room` response so the sender knows you received and understood their message (e.g., "Got it, I've reviewed the PR. Here are my findings: ...").

## Sending Messages

Place your message at the **END** of your response, after all work is complete. Start your message with a brief acknowledgment of what you received before giving your full response.

- **Broadcast** to all participants: `@room <your message>`
- **Direct message** to one participant: `@<name> <your message>`

### Examples

```
@room I've finished reviewing the code. The null check on line 42 needs fixing.
```

```
@author The implementation looks good. I've pushed a suggested refactor.
```

## Turn Discipline

- You get **one turn** per incoming message.
- When you receive a message, acknowledge and respond to it first, then do your work, then send ONE `@room` message at the end.
- **ONE** `@room` or `@<name>` message per turn maximum.
- If you have **nothing to say**, finish your response without any `@room` message. Your turn ends silently and you will wait for the next incoming message.
- Do NOT send multiple `@room` messages in a single turn.

## Message Prefixes (Coordination Protocol)

### REVIEW_REQUEST: — Coder requests code review

When the coder has finished implementing and wants the reviewer to start:

```
@room REVIEW_REQUEST: Code is ready for review. Repo: https://github.com/org/repo, Branch: main. Summary: Built a task manager with drag-and-drop.
```

The `REVIEW_REQUEST:` prefix signals to the reviewer that code is ready. **Coders: only send this when:**
1. All code is committed and pushed to the remote
2. Tests and lint pass
3. The app builds and runs successfully

### REVIEW_FEEDBACK: — Reviewer sends feedback

```
@room REVIEW_FEEDBACK: Reviewed main. Found 3 issues:
1. [CRITICAL] src/db/schema.ts:42 — Missing foreign key
2. [BUG] src/routes/api/tasks.ts:15 — DELETE doesn't check ownership
3. [STYLE] src/components/TaskList.tsx:88 — Unused import
```

### APPROVED: — Reviewer approves the code (TERMINAL — cycle ends)

```
@room APPROVED: Code review passed. Schema is clean, API routes handle errors correctly, tests cover main flows.
```

**When the coder receives APPROVED:** Do NOT send any further `@room` messages. The review cycle is complete. Finish your turn silently (no `@room` directive). Sending another REVIEW_REQUEST after APPROVED creates an infinite loop.

**When the reviewer sends APPROVED:** This is your final message for this review cycle. Do not send further messages unless a new REVIEW_REQUEST arrives.

### GATE: — Request human input

```
@room GATE: Should we use Redis or Memcached for the caching layer?
```

The `GATE:` prefix pauses the conversation until a human responds. Use this sparingly — only when you genuinely need human input to proceed.

## Discovery

When you first join a room, you receive:
- Your name and role in the room
- A list of other participants and their roles
- Recent conversation history (if any)

Use participant names to address them directly with `@<name>`.

## Key Rules

1. Always respond to incoming messages before doing other work
2. One `@room` or `@<name>` per turn — no more
3. The `@room` or `@<name>` directive **MUST** start on its own line — never inline in a paragraph. The parser only recognises directives at the start of a line.
4. No `@room` = silence (your turn ends, you wait)
5. `GATE:` = need human input
6. `REVIEW_REQUEST:` = coder is ready for review (reviewer should start)
7. `APPROVED:` = reviewer approves the code
