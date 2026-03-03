# @electric-agent/agent

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
