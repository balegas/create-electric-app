# @electric-agent/agent

## 1.4.20

### Patch Changes

- Updated dependencies [6cf403d]
  - @electric-agent/studio@1.20.0

## 1.4.19

### Patch Changes

- 4f16586: Fix Sprites runtime: separate SPRITES_API_TOKEN from FLY_API_TOKEN, fix SDK compatibility with @fly/sprites 0.0.1-rc37, remove global session cap, stop logging agent prompts to UI, and lazy-load serve command to unblock scaffold in sprites.
- Updated dependencies [cf0335d]
- Updated dependencies [4f16586]
- Updated dependencies [66f3de4]
  - @electric-agent/studio@1.19.4

## 1.4.18

### Patch Changes

- Updated dependencies [2d818b9]
- Updated dependencies [ef4cf83]
- Updated dependencies [4c989c3]
  - @electric-agent/studio@1.19.3

## 1.4.17

### Patch Changes

- Updated dependencies [a558dc4]
  - @electric-agent/studio@1.19.2

## 1.4.16

### Patch Changes

- Updated dependencies [69d7c22]
  - @electric-agent/studio@1.19.1

## 1.4.15

### Patch Changes

- e7ff122: Room improvements: move infra gate to room page, cascade-delete agents, persist sessions, markdown messages.

  - Infrastructure configuration is now a room-level concern — the gate renders inline in the room page instead of requiring navigation to a coder session
  - Deleting a room cascades to delete all associated agent sessions
  - Room-session mappings are persisted to durable stream so rooms survive server restarts (interrupted rooms show correct status)
  - Room messages render with markdown formatting (code blocks, headings, lists)
  - Pre-create sprite checkpoints in CI after deploy to eliminate slow bootstrap
  - Fix plan approval regression: revert clarification to use AskUserQuestion instead of non-blocking @room GATE
  - Fix infra gate race condition: create gate before async flow so it's visible immediately
  - Gate resolution broadcasts summary to room as system message

- Updated dependencies [37671fb]
- Updated dependencies [e7ff122]
- Updated dependencies [5a41432]
  - @electric-agent/studio@1.19.0

## 1.4.14

### Patch Changes

- 884a450: Room improvements: move infra gate to room page, cascade-delete agents, persist sessions, markdown messages.

  - Infrastructure configuration is now a room-level concern — the gate renders inline in the room page instead of requiring navigation to a coder session
  - Deleting a room cascades to delete all associated agent sessions
  - Room-session mappings are persisted to durable stream so rooms survive server restarts (interrupted rooms show correct status)
  - Room messages render with markdown formatting (code blocks, headings, lists)
  - Pre-create sprite checkpoints in CI after deploy to eliminate slow bootstrap
  - Fix plan approval regression: revert clarification to use AskUserQuestion instead of non-blocking @room GATE
  - Fix infra gate race condition: create gate before async flow so it's visible immediately
  - Gate resolution broadcasts summary to room as system message

- Updated dependencies [884a450]
- Updated dependencies [6b19d68]
- Updated dependencies [884a450]
- Updated dependencies [754b620]
  - @electric-agent/studio@1.18.0

## 1.4.13

### Patch Changes

- Updated dependencies [8e064a7]
  - @electric-agent/studio@1.17.2

## 1.4.12

### Patch Changes

- Updated dependencies [08840aa]
  - @electric-agent/studio@1.17.1

## 1.4.11

### Patch Changes

- Updated dependencies [b6e765d]
  - @electric-agent/studio@1.17.0

## 1.4.10

### Patch Changes

- b835db5: Add room messaging protocol with gated questions to CLAUDE.md for all agents.

  - Embed the room messaging protocol (including `@room GATE:` for human input) directly in generated CLAUDE.md via a new `roomParticipant` option
  - Export `ROOM_MESSAGING_SECTION` for appending to existing CLAUDE.md files when agents join rooms mid-session
  - Update create-app skill to use `@room GATE:` for clarification when in a room context (falls back to AskUserQuestion in solo sessions)
  - Replace inline room-messaging reference strings in server.ts with the shared constant

- Updated dependencies [b835db5]
  - @electric-agent/studio@1.16.0

## 1.4.9

### Patch Changes

- 50fa113: Room improvements: fix review loop, remove per-agent gating, update messaging

  - Fix coder-reviewer infinite loop: coder skill now distinguishes REVIEW_FEEDBACK from APPROVED, room router auto-closes on APPROVED, maxRounds enforced
  - Remove per-agent `gated` option from addParticipant and UI (GATE: prefix for human input still works)
  - Update "local-first" references to "reactive, real-time" to match Electric SQL's current positioning
  - UI designer skill uses AskUserQuestion with multiSelect for presenting improvement suggestions

- Updated dependencies [50fa113]
  - @electric-agent/studio@1.15.0
  - @electric-agent/protocol@1.8.3

## 1.4.8

### Patch Changes

- b3da804: Add repository.url to all packages and remove NPM_TOKEN from release workflow for npm trusted publishing (OIDC).
- Updated dependencies [b3da804]
  - @electric-agent/studio@1.14.2
  - @electric-agent/protocol@1.8.2

## 1.4.7

### Patch Changes

- 9631599: Remove auto-announced fallback REVIEW_REQUEST messages when coder finishes without sending one. Add reviewer guardrails to validate REVIEW_REQUEST content before starting review. Remove ARCHITECTURE.md from create-app plan and make final REVIEW_REQUEST step mandatory and explicit.
- Updated dependencies [c1515e6]
- Updated dependencies [9631599]
  - @electric-agent/studio@1.14.1

## 1.4.6

### Patch Changes

- Updated dependencies [b0f6be8]
  - @electric-agent/studio@1.14.0
  - @electric-agent/protocol@1.8.1

## 1.4.5

### Patch Changes

- Updated dependencies [622d337]
- Updated dependencies [622d337]
  - @electric-agent/studio@1.13.3

## 1.4.4

### Patch Changes

- b2549bd: Always show the Open App button in the UI when a preview URL or port is available, regardless of app completion state. Add a DONE room message to the create-app skill's final phase to signal pipeline completion. Initialize all agents with repo info (URL, branch) via the room router's discovery prompt so they can clone and review code locally.
- Updated dependencies [b2549bd]
- Updated dependencies [6e69388]
- Updated dependencies [75fbc3d]
  - @electric-agent/studio@1.13.2

## 1.4.3

### Patch Changes

- Updated dependencies [3f6b96c]
- Updated dependencies [90b3712]
- Updated dependencies [3f6b96c]
  - @electric-agent/studio@1.13.1

## 1.4.2

### Patch Changes

- 9cbc6f8: Add hosted production mode with server-side Claude API key, rate limiting (global session cap, per-IP limits, per-session cost budget), GitHub App integration for automatic repo creation under electric-apps org, git credential helper for transparent token management in sandboxes, and random slug naming for prod repos. Dev mode retains full credential UI and no rate limits. Agent template updated with README writing step in create-app skill.
- Updated dependencies [9cbc6f8]
- Updated dependencies [5591cbd]
- Updated dependencies [e17104c]
  - @electric-agent/studio@1.13.0

## 1.4.1

### Patch Changes

- Updated dependencies [2874544]
- Updated dependencies [d2f56e8]
  - @electric-agent/studio@1.12.1

## 1.4.0

### Minor Changes

- 27da189: Lean create-app skill: delegate implementation details to playbook skills

  The create-app skill was rewritten to be an orchestration layer rather than a prescriptive code template. Implementation details (collection setup, mutations, live queries, API routes) are now delegated to playbook skills shipped with npm dependencies (`@electric-sql/client`, `@tanstack/db`, `@tanstack/react-db`), discovered dynamically via `npx @tanstack/intent list`.

  Key changes:

  - Added Phase 2 "Discover & Learn" that runs `npx @tanstack/intent list` after plan approval
  - Removed code templates that duplicated playbook content (52% smaller skill)
  - Fixed wrong hardcoded playbook paths in CLAUDE.md (`@electric-sql/playbook/` → dynamic discovery)
  - Reduced CLAUDE.md/skill duplication (drizzle workflow, SSR rules, playbook paths)
  - Kept scaffold-specific gotchas not covered by playbooks (zod/v4, protected files, import rules)
  - Added `scripts/setup-local-sandbox.sh` for local testing of the agent pipeline

### Patch Changes

- 5dab3fe: Update TanStack DB dependency versions in scaffold: @tanstack/db 0.5.31→0.5.32, @tanstack/react-db 0.1.75→0.1.76, @tanstack/electric-db-collection 0.2.39→0.2.40.
- Updated dependencies [93f5982]
- Updated dependencies [b4056bd]
- Updated dependencies [27da189]
- Updated dependencies [4cfbddf]
- Updated dependencies [806c25a]
- Updated dependencies [249eea5]
- Updated dependencies [806c25a]
- Updated dependencies [3f5e22a]
  - @electric-agent/studio@1.12.0
  - @electric-agent/protocol@1.8.0

## 1.3.0

### Minor Changes

- 41c4dc9: Remove Daytona sandbox provider. The project now supports two sandbox runtimes: Docker (local) and Sprites (Fly.io cloud).

### Patch Changes

- f14b9ff: Align guardrails with TanStack playbooks and restore skill discovery.

  - Adopt TanStack's `z.union([z.string(), z.date()]).transform().default()` timestamp
    pattern (from tanstack-db/collections/SKILL.md) — strictly better than our old
    `z.union([z.date(), z.string()]).default()` because it converts strings to Dates
  - Remove stale `z.coerce.date()` ban — works correctly with zod >=3.25
  - Bump zod from `^3.24` to `^3.25` to satisfy drizzle-zod 0.8.x peer dep
  - Add all TanStack DB sub-skills (collections, schemas, mutations, live-queries,
    electric) to playbook listing with updated reading order
  - Integrate `npx @tanstack/intent list` into create-app Phase 1 for dynamic
    skill discovery
  - Keep `zod/v4` import requirement (verified: drizzle-zod rejects v3 overrides)
  - Revert fragile mv/cat/append CLAUDE.md merge back to simple overwrite

- 41c4dc9: Rewrite project documentation from scratch. Add docs/ directory with detailed reference docs covering protocol & events, multi-agent rooms, sandboxes & bridges, security & authentication, architecture, and publishing. Rewrite README as a concise quick-start guide. Update CLAUDE.md with clear development instructions, pre-commit checklist, and changeset requirements.
- Updated dependencies [ff36816]
- Updated dependencies [b80b6e0]
- Updated dependencies [1434666]
- Updated dependencies [41c4dc9]
- Updated dependencies [f14b9ff]
- Updated dependencies [41c4dc9]
- Updated dependencies [5c53e82]
- Updated dependencies [29d02f3]
  - @electric-agent/studio@1.11.0
  - @electric-agent/protocol@1.7.0

## 1.2.2

### Patch Changes

- e9ee43b: Adopt @tanstack/intent for skill discovery: remove hardcoded playbook paths from CLAUDE.md generator, prepend Electric-specific instructions on top of KPB's CLAUDE.md (preserving intent skill mappings), bump TanStack/Electric dependency versions, and remove stale durable-streams references.
- Updated dependencies [516c152]
- Updated dependencies [d71c691]
- Updated dependencies [fd7e0d2]
- Updated dependencies [e9ee43b]
  - @electric-agent/studio@1.10.0

## 1.2.1

### Patch Changes

- Updated dependencies [ec4822f]
- Updated dependencies [605e845]
- Updated dependencies [f7fbab8]
- Updated dependencies [57fd4ac]
- Updated dependencies [e3dccd2]
  - @electric-agent/protocol@1.6.0
  - @electric-agent/studio@1.9.0

## 1.2.0

### Minor Changes

- 07c78c1: Add ui-design skill for interactive UI iteration with Radix UI Themes patterns, Electric brand theme patching in scaffold, and enhanced Phase 4 guidance in create-app pipeline.

### Patch Changes

- Updated dependencies [a34184d]
- Updated dependencies [7163eee]
- Updated dependencies [a6309e6]
  - @electric-agent/studio@1.8.0
  - @electric-agent/protocol@1.5.0

## 1.1.9

### Patch Changes

- Updated dependencies [da2f763]
  - @electric-agent/studio@1.7.0

## 1.1.8

### Patch Changes

- Updated dependencies [d259e9d]
- Updated dependencies [6bbb48a]
- Updated dependencies [e25eb4b]
- Updated dependencies [e21e8a7]
  - @electric-agent/studio@1.6.0
  - @electric-agent/protocol@1.4.0

## 1.1.7

### Patch Changes

- Updated dependencies [6c3de57]
  - @electric-agent/studio@1.5.0

## 1.1.6

### Patch Changes

- 330e28f: Add Phase 7 (Deploy & Preview) to PLAN.md template in SKILL.md

  The plan template only listed phases 1-6 in the Implementation Tasks checklist, missing the final deploy/preview phase that corresponds to Phase 8 in the SKILL.md workflow.

## 1.1.5

### Patch Changes

- 43230e0: Support full AskUserQuestion capabilities: multiSelect, multiple questions, and headers

  - Add `AskUserQuestionItem` interface and `questions` field to the `ask_user_question` protocol event
  - Pass through full `questions` array (with `header`, `multiSelect`) from Claude Code stream-json and hook events
  - Rewrite `AskUserQuestionGate` UI to render multiple questions, multiSelect checkboxes, and header chips
  - Extract duplicated `sendGateResponse()` logic from Docker and Sprites bridges into shared `formatGateMessage()` helper
  - Switch gate resolution from single `answer` string to `answers: Record<string, string>` with backwards compat
  - Update SKILL.md Phase 0 to be less prescriptive about clarification format

- Updated dependencies [43230e0]
  - @electric-agent/protocol@1.3.0
  - @electric-agent/studio@1.4.0

## 1.1.4

### Patch Changes

- c9d046b: Settings UI: replace two API key fields with single input + key type dropdown, add keychain detection notes. Make collapsible chat messages selectable for copy-paste. Add deploy phase to SKILL.md execution instructions and strengthen dev server instructions to prevent sprite-env services misuse.
- Updated dependencies [c9d046b]
  - @electric-agent/studio@1.3.4

## 1.1.3

### Patch Changes

- Updated dependencies [b9a9542]
  - @electric-agent/studio@1.3.3

## 1.1.2

### Patch Changes

- Updated dependencies [8d67675]
  - @electric-agent/studio@1.3.2

## 1.1.1

### Patch Changes

- Updated dependencies [f28371e]
- Updated dependencies [c4bf020]
  - @electric-agent/studio@1.3.1

## 1.1.0

### Minor Changes

- e150c6b: Remove electric-agent mode, fix AskUserQuestion hook blocking, and UI improvements

  - Remove the custom Agent SDK pipeline (Clarifier, Planner, Coder) — only Claude Code bridge mode remains
  - Fix AskUserQuestion hooks in Docker and Sprites bridges: correct nested hook format, comma-separated --allowedTools flag, base64 file encoding
  - Fix Sprites bridge race condition: await hook installation before spawning Claude Code
  - Fix Sprites bridge studioUrl config: resolve server URL for remote sandboxes via FLY_APP_NAME
  - Fix local hook setup script (/api/hooks/setup) to use correct nested hook format
  - Add "Other..." free text input option to AskUserQuestion gate UI
  - Fix gate selection display: show resolved summary for plan and clarification gates
  - UI fixes: markdown heading sizes, sidebar delete button, tool execution display

### Patch Changes

- Updated dependencies [e150c6b]
  - @electric-agent/protocol@1.2.0
  - @electric-agent/studio@1.3.0

## 1.0.4

### Patch Changes

- Updated dependencies [9675f38]
- Updated dependencies [77b1eef]
- Updated dependencies [0ae9f33]
  - @electric-agent/studio@1.2.0

## 1.0.3

### Patch Changes

- Updated dependencies [76cbfd0]
  - @electric-agent/studio@1.1.2

## 1.0.2

### Patch Changes

- Updated dependencies [1af3021]
  - @electric-agent/studio@1.1.1

## 1.0.1

### Patch Changes

- fixes to sprites
- Updated dependencies [89d4cb6]
- Updated dependencies [ba8f908]
- Updated dependencies [a99ba74]
  - @electric-agent/studio@1.1.0
  - @electric-agent/protocol@1.1.0

## 1.0.0

### Major Changes

- e494542: restructured

### Minor Changes

- 9d0e4a0: monorepo
- a5c4703: Convert to pnpm workspaces monorepo with three packages: protocol, studio, and agent

### Patch Changes

- Updated dependencies [9d0e4a0]
- Updated dependencies [a5c4703]
- Updated dependencies [e494542]
  - @electric-agent/protocol@1.0.0
  - @electric-agent/studio@1.0.0
