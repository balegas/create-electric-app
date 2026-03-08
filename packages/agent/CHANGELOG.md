# @electric-agent/agent

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
