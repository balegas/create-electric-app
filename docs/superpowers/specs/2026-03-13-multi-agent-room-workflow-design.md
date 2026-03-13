# Multi-Agent Room-Based App Creation Workflow

## Summary

Transform the app creation flow from a single-agent session into a multi-agent room. When a user describes an app, the system transparently creates a room with 3 collaborating agents — each in its own sandbox — that coordinate via GitHub and room messages.

## Motivation

The current single-agent flow handles everything sequentially: code generation, build, and optional UI polish. By splitting responsibilities across specialized agents that work in parallel, we get:

- **Better quality**: a dedicated reviewer catches issues the coder misses
- **Better UI**: a dedicated UI designer with strong aesthetic direction polishes the interface
- **Collaboration model**: agents coordinate via room messages and GitHub PRs, mirroring how human teams work
- **Impressive UX**: the user sees 3 agents spinning up and collaborating in real-time

## Agents

### 1. Coder

- **Role**: `"coder"`
- **Tools**: Full write access (Read, Write, Edit, Bash, Glob, Grep, WebSearch, TodoWrite, AskUserQuestion, Skill)
- **Prompt**: `/create-app {description}`
- **Sandbox**: Full scaffold setup (same as today's single session)
- **Behavior**:
  - Follows the create-app skill pipeline (clarify → plan → data model → collections → API → UI → build → docs)
  - The base UI MUST use the Electric brand theme (violet/mauve/medium/translucent) — enforced by the create-app skill's Phase 5 and baked into the scaffold template's `__root.tsx`
  - After completion: commits to main, pushes to GitHub, sends `@room DONE: <summary with repo URL>`
  - Does NOT invoke `/ui-design` at the end (removed from Phase 7)
  - Does NOT create a PR for the initial build — commits directly to main (same as today)
  - Responds to reviewer feedback by pushing fixes to main and notifying

### 2. Reviewer

- **Role**: `"reviewer"`
- **Tools**: Read-only + Bash (Read, Bash, Glob, Grep, WebSearch, TodoWrite, AskUserQuestion, Skill)
- **Prompt**: Initial instructions to wait for coder's DONE signal
- **Sandbox**: Empty sandbox (no scaffold), clones repo when notified
- **Behavior**:
  - Waits idle until receiving `@room DONE:` from the coder
  - Clones the repo from GitHub into its sandbox
  - Reviews the code on main directly (no PR — the coder commits to main)
  - Sends feedback to the coder via `@room` with specific, actionable comments
  - Loops with coder: feedback → wait for fixes → re-review → approve
  - Reviews UI designer's PR when it arrives (uses `gh pr review` since UI designer works on branches)
  - After approving UI designer's PR, notifies room

### 3. UI Designer

- **Role**: `"ui-designer"`
- **Tools**: Full write access (same as coder — needs Write/Edit/Bash to modify code and run dev server)
- **Prompt**: Initial instructions to wait for coder's DONE signal
- **Sandbox**: Empty sandbox (no scaffold), clones repo when notified, runs dev server for live preview
- **Behavior**:
  - Waits idle until receiving `@room DONE:` from the coder
  - Clones the repo from GitHub into its sandbox
  - Installs dependencies, starts the dev server (so user can preview changes via sandbox URL)
  - Audits all route/component files against:
    - Electric brand theme (violet/mauve design system from ui-design skill)
    - KPB frontend-design aesthetics (bold typography, intentional color, motion/micro-interactions, spatial composition, atmospheric backgrounds)
    - Radix UI Themes best practices and component patterns
  - Presents findings to the user via `@room GATE:` — what looks good, what needs improvement, proposed changes
  - If user approves improvements:
    - Creates a feature branch
    - Makes UI changes
    - Pushes and creates a PR
    - Notifies reviewer via `@room` that UI PR is ready
    - Waits for reviewer approval before merging
  - After merge (or if user declines): asks if user wants more iterations
  - Each iteration follows the same branch → PR → review → merge cycle

## Server Changes

### New endpoint: `POST /api/rooms/create-app`

A dedicated endpoint for the room-based app creation flow. The existing `POST /api/sessions` remains unchanged for freeform sessions.

Request body: same as `createSessionSchema` (description, apiKey, oauthToken, ghToken, etc.) minus the `freeform` field.

Response: `{ roomId, roomToken, sessions: { coder: string, reviewer: string, uiDesigner: string } }`

Flow:

1. **Rate limiting**: Check per-IP rate limit counting at the **room level** (1 room = 1 unit, not 3). Adjust `checkSessionRateLimit` to accept a weight or add a separate room-level counter.
2. **Create room**: `RoomRouter` + durable stream. Room name derived from project description.
3. **Infra config gate**: Emit on the **room stream** (not a session stream). The RoomPage renders the gate. Resolves once — the resolved config is shared across all 3 sandboxes.
4. **GitHub repo creation**: In prod mode, create the repo before spawning agents. In dev mode, use the config from the infra gate. The repo URL is passed to all 3 agents.
5. **Spawn 3 agents in parallel**: Each gets its own sandbox, session stream, role skill, room-messaging skill, and tool permissions.

#### Coder agent setup
- Full scaffold setup (copy scaffold base, write CLAUDE.md, write create-app skill)
- GitHub repo initialized in sandbox (git init, remote add)
- Prompt: `/create-app {description}`
- Role skill: coder (with `@room DONE:` completion instruction)

#### Reviewer agent setup
- Minimal sandbox (no scaffold, no Electric infra)
- GitHub credentials configured (gh auth, git config)
- CLAUDE.md with room context + repo URL
- Role skill: reviewer (with "wait for DONE" instruction)
- Prompt: "You are 'reviewer'. Read your role skill, then wait for the coder to finish."

#### UI Designer agent setup
- Minimal sandbox (no scaffold, no Electric infra)
- GitHub credentials configured
- CLAUDE.md with room context + repo URL
- Role skill: ui-designer (with "wait for DONE" instruction)
- Prompt: "You are 'ui-designer'. Read your role skill, then wait for the coder to finish."

6. **Return**: `{ roomId, roomToken, sessions }` immediately (sandbox creation continues async).

### Failure handling

If the coder's session ends without sending `@room DONE:` (crash, cost limit, cancellation):

- The server's `bridge.onComplete()` handler detects the coder session ended
- Server sends a room message on behalf of the coder: `"Coder session ended unexpectedly (status: error). No DONE signal was sent."`
- The reviewer and UI designer receive this message and should respond gracefully:
  - If the repo exists and has code, they can still clone and review/audit
  - If no repo exists, they send `@room GATE:` to inform the user of the failure
- The server does NOT automatically tear down the other agents — the user can still interact with them or close the room manually

If GitHub repo creation fails:

- The coder falls back to working locally (no push, no DONE with repo URL)
- Server emits a log event: "GitHub repo creation failed — agents will work locally"
- The reviewer and UI designer cannot clone — they inform the user via `@room GATE:`
- The room continues but in a degraded mode (coder works solo)

### Infra config gate in room context

The infra config gate is emitted to the room's event stream and rendered on the RoomPage. The RoomPage already has gate rendering via the `RoomEventList` component. The gate UI (Docker/Cloud selection + optional GitHub config) renders inline in the room view — the user resolves it there, and the server proceeds with sandbox creation for all 3 agents.

## Client Changes

### Navigation

`AppShell.tsx` `handleNewProject`:
- **Non-freeform**: Navigate to `/room/new` with `{ state: { description } }` instead of `/session/new`
- **Freeform**: Continue navigating to `/session/new` (unchanged)

### RoomPage handling of `/room/new`

The existing RoomPage route (`/room/:id`) handles `id === "new"` similarly to how SessionPage handles it:

1. Detect `id === "new"` + extract `description` from `location.state`
2. Call `POST /api/rooms/create-app` with the description
3. Store room token in localStorage via `agent-room-store`
4. Navigate to `/room/{roomId}` with `replace: true`

### Room store updates

Extend `AgentRoomEntry` in `agent-room-store.ts` to track session IDs:

```typescript
interface AgentRoomEntry {
  id: string
  code: string
  name: string
  createdAt: string
  sessions?: {
    coder: string
    reviewer: string
    uiDesigner: string
  }
}
```

This allows the sidebar to show the room and its agent sessions, and lets the RoomPage correlate participants with their session streams.

### RoomPage BUILT_IN_ROLES

Add `"ui-designer"` to the `BUILT_IN_ROLES` array in `RoomPage.tsx` so users can also add UI designer agents manually to any room.

## Role Skills

### New: `.claude/skills/roles/ui-designer/SKILL.md`

```markdown
# UI Designer Role

You are a **UI designer** agent. Your job is to audit and improve the user interface of apps built by the coder agent.

## Wait for the App

Do NOT start any work until you receive a `@room DONE:` message from the coder.
When you receive it, the message will include the GitHub repo URL.
If the coder's session ends without a DONE message, check the room for context and inform the user.

## Setup

1. Clone the repo: `git clone <repo-url> .`
2. Install dependencies: `pnpm install`
3. Run migrations: `pnpm drizzle-kit migrate`
4. Start the dev server: `pnpm dev:start`
5. Verify the app is running

## Audit the UI

Read all route and component files:
- `src/routes/**/*.tsx`
- `src/components/**/*.tsx`

Evaluate against these criteria:

### Electric Brand Theme
The app MUST use the Electric theme in `__root.tsx`:
- `accentColor="violet"` (Electric brand purple)
- `grayColor="mauve"` (gray with violet undertone)
- `radius="medium"` (balanced corners)
- `panelBackground="translucent"` (subtle depth)

### Design Quality
- **Typography**: Full typographic range — size, weight, color for hierarchy. Large headings for page titles, medium for sections, appropriate text colors for primary/secondary content.
- **Color with conviction**: Use the accent color intentionally for primary actions. Secondary actions use `color="gray"`, destructive use `color="red"`. Avoid timid, evenly-distributed palettes.
- **Spatial composition**: Purposeful layouts with `justify="between"` for headers, consistent gap scale, visual weight through Card/Table surfaces. Avoid everything-centered layouts.
- **Component usage**: All interactive elements from `@radix-ui/themes`. Status indicators via `Badge variant="soft"` with semantic colors. Proper empty states, loading states, delete confirmations.
- **Atmosphere**: Card `variant="surface"` for depth. Subtle visual details that match the app's purpose. No raw HTML elements or inline styles.
- **Motion and micro-interactions**: Subtle transitions for state changes. Staggered reveals on page load. Hover states that surprise.
- **Contextual design**: Every app has a different purpose and audience. Match the aesthetic to the domain.

### Anti-patterns to Flag
- Raw HTML (`<button>`, `<input>`, `<table>`) instead of Radix components
- Inline `style={{}}` for spacing/colors
- Missing empty states, loading states, or error handling
- Giant forms without Dialog/structure
- Flat visual hierarchy — no Cards or surface depth
- Spacing on Text/Heading elements (should use gap on parent Flex)

## Present Findings

Send a `@room GATE:` message to the user with:
- What looks good (patterns already well-implemented)
- What needs improvement (specific violations with file:line references)
- Quick wins (highest visual impact changes)
- Your proposed improvement plan

Wait for the user's response before proceeding.

## Implement Improvements

If the user approves:
1. Create a feature branch: `git checkout -b ui-improvements`
2. Make the UI changes
3. Run build and lint: `pnpm run build && pnpm run check`
4. Commit with meaningful message
5. Push: `git push -u origin ui-improvements`
6. Create PR: `gh pr create --title "UI improvements" --body "<description>"`
7. Notify the reviewer: `@reviewer UI improvements PR is ready for review: <PR URL>`

## Wait for Review

Wait for the reviewer to review your PR. When you receive feedback:
1. Address each comment
2. Push fixes
3. Notify reviewer that fixes are pushed

After the reviewer approves:
1. Merge the PR: `gh pr merge <number> --merge`
2. Notify the room: `@room UI improvements merged to main`

## Iterate

Ask the user if they want more UI improvements:
`@room GATE: UI improvements are merged. Would you like me to make additional changes?`

If yes, repeat the audit → propose → implement → review → merge cycle.

## Boundaries

- Do NOT start work before receiving DONE from the coder
- Do NOT merge without reviewer approval
- Always create a branch — never commit directly to main
- Run build + lint before every push
- Use `@room GATE:` for user decisions
```

### Modified: `.claude/skills/roles/reviewer/SKILL.md`

Add "Wait for Work" section at the top of the workflow:

```markdown
## Wait for Work

When you join a room with a coder and/or UI designer:
- Do NOT start reviewing until you receive a `@room DONE:` message or a direct message with a PR URL
- The coder commits to main and sends `@room DONE:` — clone the repo and review the code on main
- The UI designer creates PRs on branches — review those via `gh pr view` and `gh pr diff`
- If a coder's session ends without DONE, check the room for context and inform the user
```

### Modified: `.claude/skills/roles/coder/SKILL.md`

Add completion signal instruction and clarify the workflow:

```markdown
## Completion

After all work is done (code committed to main, pushed to GitHub):
1. Send `@room DONE: App is ready. Repo: <github-repo-url>. Summary: <brief description of what was built>`
2. Wait for reviewer feedback via room messages
3. Address feedback by pushing fixes to main and notifying the reviewer
```

Remove existing PR-based workflow from the coder skill — in this context the coder works on main, not branches. The reviewer reviews the code directly, not via PR.

## Merge Policy

To avoid confusion across roles, the merge policy is:

- **Coder**: Commits directly to main. No PR. Reviewer reviews the main branch code.
- **Reviewer**: Never merges or modifies code. Only reviews and comments. Approves via room message.
- **UI Designer**: Works on feature branches. Creates PRs. Merges own PR **only after** reviewer approval.

This is consistent: the coder owns main, the UI designer uses branches+PRs for changes on top of the coder's work, and the reviewer is read-only throughout.

## Conventions

The `@room DONE:` signal is a prompt-level convention enforced by role skills, not by server code. The server does not parse or act on `DONE:` — it delivers the message to all participants like any other room message. The reviewer and UI designer are instructed by their role skills to wait for this signal before starting work.

## Skill Changes

### `packages/agent/template/.claude/skills/create-app/SKILL.md`

**Phase 7** — Remove the `/ui-design` invocation (lines 219-222):

```markdown
# REMOVE these lines:
Then invoke the UI design skill for interactive refinement:
/ui-design
```

**Phase 5** — Strengthen theme enforcement:

```markdown
## Phase 5: UI Components

**Before writing UI code**, read the ui-design skill:
- `.claude/skills/ui-design/SKILL.md` — design system, Radix UI Themes component patterns

The `__root.tsx` Theme wrapper MUST use the Electric brand defaults:
<Theme accentColor="violet" grayColor="mauve" radius="medium" panelBackground="translucent">

Also read the `react-db` and `meta-framework` skills for hook usage and SSR patterns.
```

### `packages/agent/template/.claude/skills/ui-design/SKILL.md`

Enrich with KPB frontend-design philosophy. Add a new "Design Thinking — Advanced" section after the existing "Design Thinking" section:

```markdown
## Design Thinking — Advanced

Beyond the baseline Radix patterns, aim for **distinctive, memorable interfaces**:

- **Typography with character**: Work the full typographic range. Use size, weight, and color to establish clear hierarchy. Heading `size="7"` or `size="8"` for page titles creates presence.
- **Color with conviction**: Dominant colors with sharp accents outperform timid palettes. The violet accent should feel intentional, not decorative.
- **Motion and micro-interactions**: Add subtle transitions for state changes. Focus on high-impact moments — a well-orchestrated page load with staggered reveals creates more delight than scattered animations.
- **Spatial composition**: Break out of everything-centered layouts. Use asymmetry, `justify="between"` for headers, generous negative space, and visual weight through surfaces.
- **Atmosphere and depth**: Create visual atmosphere through Card `variant="surface"`, translucent panel backgrounds, and subtle layering. The interface should feel crafted, not generated.
- **Contextual design**: Every app has a different purpose and audience. A task manager feels different from a data dashboard. Match the aesthetic to the domain.
```

## Code Changes

### `packages/studio/src/bridge/role-skills.ts`

Add `ui-designer` role:

```typescript
const ROLE_ALIASES: Record<string, string> = {
  coder: "coder",
  developer: "coder",
  programmer: "coder",
  engineer: "coder",
  reviewer: "reviewer",
  "code reviewer": "reviewer",
  "pr reviewer": "reviewer",
  "ui-designer": "ui-designer",
  "ui designer": "ui-designer",
  "frontend designer": "ui-designer",
}

const UI_DESIGNER_TOOLS = [...ALL_TOOLS] // Full write access

const ROLE_TOOLS: Record<string, string[]> = {
  coder: CODER_TOOLS,
  reviewer: REVIEWER_TOOLS,
  "ui-designer": UI_DESIGNER_TOOLS,
}
```

### `packages/studio/src/server.ts`

Add `POST /api/rooms/create-app` endpoint. The existing `POST /api/sessions` stays unchanged.

The new endpoint:

1. Validates request (same schema as `createSessionSchema` minus `freeform`)
2. Rate-limits at room level (1 room = 1 unit)
3. Creates room (RoomRouter + durable stream + registry)
4. Emits infra config gate on the room stream
5. Waits for gate resolution
6. Creates GitHub repo (prod mode) or uses gate config (dev mode)
7. Spawns 3 agents in parallel via the existing `POST /api/rooms/:id/agents` internal logic:
   - Coder: full scaffold setup
   - Reviewer: minimal sandbox + GitHub credentials
   - UI Designer: minimal sandbox + GitHub credentials
8. Returns `{ roomId, roomToken, sessions }` immediately

For failure handling, adds an `onComplete` listener on the coder's bridge that sends a room message if the coder session ends without a DONE signal.

### `packages/studio/client/src/layouts/AppShell.tsx`

Change `handleNewProject` for non-freeform:

```typescript
if (freeform) {
  navigate("/session/new", { state: { description, freeform } })
} else {
  navigate("/room/new", { state: { description } })
}
```

### `packages/studio/client/src/pages/RoomPage.tsx`

Add handling for `id === "new"`:

1. Detect `id === "new"` + extract `description` from `location.state`
2. Call `POST /api/rooms/create-app` with the description
3. Store room token + session IDs in `agent-room-store`
4. Navigate to `/room/{roomId}` with `replace: true`

Also add `"ui-designer"` to `BUILT_IN_ROLES` array.

### `packages/studio/client/src/lib/api.ts`

Add new function:

```typescript
export async function createAppRoom(description: string) {
  return request<{
    roomId: string
    roomToken: string
    sessions: { coder: string; reviewer: string; uiDesigner: string }
  }>("/rooms/create-app", { method: "POST", body: { description } })
}
```

### `packages/studio/client/src/lib/agent-room-store.ts`

Extend `AgentRoomEntry` to track session IDs:

```typescript
interface AgentRoomEntry {
  id: string
  code: string
  name: string
  createdAt: string
  sessions?: {
    coder: string
    reviewer: string
    uiDesigner: string
  }
}
```

## Scaffold Template Change

Add a `__root.tsx` to the scaffold template (`packages/agent/template/src/routes/__root.tsx`) with the Electric brand theme pre-configured. This ensures the coder starts with the correct theme even before reading the ui-design skill. Exact theme values to be discussed separately.

## File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `.claude/skills/roles/ui-designer/SKILL.md` | Create | UI designer role skill |
| `.claude/skills/roles/reviewer/SKILL.md` | Modify | Add "wait for DONE" instructions |
| `.claude/skills/roles/coder/SKILL.md` | Modify | Add `@room DONE:` completion signal, remove PR workflow |
| `packages/agent/template/.claude/skills/create-app/SKILL.md` | Modify | Remove `/ui-design` invocation, strengthen theme in Phase 5 |
| `packages/agent/template/.claude/skills/ui-design/SKILL.md` | Modify | Add KPB design philosophy section |
| `packages/studio/src/bridge/role-skills.ts` | Modify | Add `ui-designer` role + tools |
| `packages/studio/src/server.ts` | Modify | Add `POST /api/rooms/create-app` endpoint |
| `packages/studio/client/src/layouts/AppShell.tsx` | Modify | Navigate to `/room/new` for non-freeform |
| `packages/studio/client/src/pages/RoomPage.tsx` | Modify | Handle `/room/new`, add `ui-designer` to BUILT_IN_ROLES |
| `packages/studio/client/src/lib/api.ts` | Modify | Add `createAppRoom` function |
| `packages/studio/client/src/lib/agent-room-store.ts` | Modify | Extend `AgentRoomEntry` with session IDs |
| `packages/agent/template/src/routes/__root.tsx` | Create | Scaffold template with Electric theme |

## Open Questions (for later discussion)

1. **Exact Electric brand theme values**: User wants to discuss the specific theme configuration for the scaffold template after this spec is approved.
2. **Cost implications**: 3 agents = 3x sandbox cost + 3x Claude API cost. The reviewer and UI designer are idle during coding, but their sandboxes are running. Consider sandbox lifecycle management in a future iteration.
