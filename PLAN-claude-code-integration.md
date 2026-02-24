# Plan: Align EngineEvent protocol with Claude Code hooks

## Overview

Refactor the EngineEvent protocol to use names and shapes that match Claude Code's hook event system. This is a prerequisite for the local CLI bridge integration — once our events match Claude Code's vocabulary, the bridge becomes a trivial pass-through instead of a translation layer.

The refactoring is done in two phases. Each phase has a test plan that must pass before proceeding.

---

## Phase 1: Rename EngineEvent types to match Claude Code hooks

**Goal**: Rename our event types and fields to align with Claude Code's hook vocabulary, while keeping the app fully functional end-to-end.

### Renames

| Current name | New name | Rationale |
|---|---|---|
| `tool_start` | `pre_tool_use` | Matches Claude Code's `PreToolUse` hook |
| `tool_result` | `post_tool_use` | Matches Claude Code's `PostToolUse` hook |
| `assistant_text` | `assistant_message` | Matches Claude Code's transcript format |
| `assistant_thinking` | `assistant_thinking` | Already matches — no change |
| `user_message` | `user_prompt` | Matches Claude Code's `UserPromptSubmit` hook |
| `session_complete` | `session_end` | Matches Claude Code's `SessionEnd` hook |
| `clarification_needed` | `clarification_needed` | No change — our gate, not Claude Code's |
| `plan_ready` | `plan_ready` | No change — our gate |
| `continue_needed` | `continue_needed` | No change — our gate |
| `cost_update` | `cost_update` | No change |
| `phase_complete` | `phase_complete` | No change |
| `app_ready` | `app_ready` | No change |
| `git_checkpoint` | `git_checkpoint` | No change |
| `infra_config_prompt` | `infra_config_prompt` | No change |
| `gate_resolved` | `gate_resolved` | No change |
| `log` | `log` | No change |

### Field renames within events

| Event | Current field | New field | Rationale |
|---|---|---|---|
| `pre_tool_use` (was `tool_start`) | `toolName` | `tool_name` | Matches hook's `tool_name` |
| `pre_tool_use` | `toolUseId` | `tool_use_id` | Matches hook's `tool_use_id` |
| `pre_tool_use` | `input` | `tool_input` | Matches hook's `tool_input` |
| `post_tool_use` (was `tool_result`) | `toolUseId` | `tool_use_id` | Matches hook's `tool_use_id` |
| `post_tool_use` | `output` | `tool_response` | Matches hook's `tool_response` |

### New event type

| New type | Fields | Rationale |
|---|---|---|
| `post_tool_use_failure` | `tool_use_id`, `tool_name`, `error`, `agent?`, `ts` | Matches Claude Code's `PostToolUseFailure` — currently errors are indistinguishable from successes in `tool_result` |
| `session_start` | `session_id`, `cwd?`, `agent?`, `ts` | Matches Claude Code's `SessionStart` — needed for local bridge |

### New optional field

| Event | New field | Type | Purpose |
|---|---|---|---|
| `post_tool_use` | `error?` | `string` | Distinguish tool failure when not using separate `post_tool_use_failure` type |

### Files to change

1. **`src/engine/events.ts`** — rename types and fields (source of truth)
2. **`src/web/client/src/lib/event-types.ts`** — mirror renames (client copy)
3. **`src/engine/message-parser.ts`** — update `sdkMessageToEvents()` to emit new names
4. **`src/engine/orchestrator.ts`** — update all `emit()` calls
5. **`src/engine/stream-adapter.ts`** — no changes (passes events opaquely)
6. **`src/engine/stdio-adapter.ts`** — no changes (passes events opaquely)
7. **`src/web/client/src/hooks/useSession.ts`** — update `processEvent()` reducer cases
8. **`src/web/client/src/components/Console.tsx`** — update `ConsoleEntry` kind references
9. **`src/web/client/src/components/ConsoleEntry.tsx`** — update kind references
10. **`src/web/client/src/components/ToolExecution.tsx`** — update `tool_name`, `tool_input`, `tool_response` field names
11. **`src/web/client/src/components/GatePrompt.tsx`** — update gate type references
12. **`src/web/server.ts`** — update SSE proxy filter for new type names
13. **`src/web/bridge/hosted.ts`** — update `session_complete` → `session_end` detection
14. **`src/cli/headless.ts`** — update any event type references
15. **`tests/bridge.test.ts`** — update event type names in test fixtures
16. **`tests/streams.test.ts`** — update event type names in test fixtures

### ConsoleEntry renames (client-side)

The `ConsoleEntry` type uses `kind` to distinguish UI entries. Renames:

| Current `kind` | New `kind` | Rationale |
|---|---|---|
| `tool` | `tool_use` | Encompasses both pre/post, aligns with Claude Code |
| `text` | `assistant_message` | Matches event rename |
| `thinking` | `assistant_thinking` | Already aligned |
| `user_message` | `user_prompt` | Matches event rename |
| `log` | `log` | No change |
| `gate` | `gate` | No change |

Field renames within `ConsoleEntry`:

| Kind | Current field | New field |
|---|---|---|
| `tool_use` | `toolName` | `tool_name` |
| `tool_use` | `toolUseId` | `tool_use_id` |
| `tool_use` | `input` | `tool_input` |
| `tool_use` | `output` | `tool_response` |

### Implementation order

1. Update `src/engine/events.ts` (server types)
2. Update `src/web/client/src/lib/event-types.ts` (client types)
3. Run `npx tsc --noEmit` — use compiler errors to find every reference
4. Fix each file following the compiler errors
5. Run `npm run check:fix` to fix formatting
6. Run `npm run build` to verify full build
7. Run `npm test` to verify existing tests pass

### Phase 1 test plan

Before moving to Phase 2, **all of these must pass**:

```bash
# 1. Type-check (zero errors)
npx tsc --noEmit

# 2. Lint + format (zero errors)
npm run check

# 3. Full build (TypeScript + Vite SPA)
npm run build

# 4. Unit + integration tests
npm test

# 5. Manual verification: events flow through stream correctly
#    (covered by existing streams.test.ts and bridge.test.ts)
```

Acceptance criteria:
- [ ] All 16 event types use new names in both server and client
- [ ] All field names use snake_case matching Claude Code's hook schemas
- [ ] `ConsoleEntry` kinds match the new event names
- [ ] `useSession.ts` reducer handles all renamed types
- [ ] All UI components render correctly with renamed fields
- [ ] SSE proxy filter in `server.ts` works with new type names
- [ ] Bridge `session_end` detection works (was `session_complete`)
- [ ] `npm run build` succeeds (TypeScript + Vite)
- [ ] `npm test` passes (bridge, streams, NDJSON, scaffold tests)
- [ ] `npm run check` passes (Biome lint + format)

---

## Phase 2: Hook-to-stream bridge (future — after Phase 1)

_Planned but not started. Details in the earlier discussion. Depends on Phase 1 being complete and tested._

---

## Phase 3: Session registration + local sessions (future)

_Planned but not started. Depends on Phase 2._

---

## Phase 4: Docker integration test for local bridge (future)

_Planned but not started. Depends on Phase 3._
