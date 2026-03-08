# Room Messaging Protocol

You are participating in a multi-agent room where multiple Claude Code agents communicate through a shared message stream. This skill describes how to send and receive messages.

## Receiving Messages

Messages from other participants arrive as iteration prompts in this format:

```
Message from <sender_name>:

<message body>
```

When you receive a message, process it fully (make code changes, run tests, analyze, etc.), then respond.

## Sending Messages

Place your message at the **END** of your response, after all work is complete.

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
- Do all your work first (code changes, analysis, testing), then send ONE `@room` message.
- **ONE** `@room` message per turn maximum.
- If you have **nothing to say**, finish your response without any `@room` message. Your turn ends silently and you will wait for the next incoming message.
- Do NOT send multiple `@room` messages in a single turn.

## Ending the Conversation

When the task is complete or consensus is reached, signal completion:

```
@room DONE: Successfully implemented and reviewed the caching layer. All tests pass.
```

The `DONE:` prefix tells the system the conversation is finished. Include a brief summary.

## Requesting Human Input

When you need a human decision or want to pause for human review:

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

1. Always finish your work before sending a message
2. One `@room` per turn — no more
3. No `@room` = silence (your turn ends, you wait)
4. `DONE:` = conversation over
5. `GATE:` = need human input
