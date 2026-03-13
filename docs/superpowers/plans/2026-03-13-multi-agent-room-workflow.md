# Multi-Agent Room-Based App Creation — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform app creation from single-agent sessions into transparent multi-agent rooms with coder, reviewer, and UI designer agents.

**Architecture:** When a user submits a non-freeform app description, the server creates a room with 3 agents in separate sandboxes. The coder builds the app, sends `@room DONE:`, then the reviewer and UI designer spring into action — coordinating via room messages and GitHub.

**Tech Stack:** TypeScript, Hono (server), React + react-router (client), Docker sandboxes, Claude Code CLI, Durable Streams

**Spec:** `docs/superpowers/specs/2026-03-13-multi-agent-room-workflow-design.md`

---

## Chunk 1: Role Skills & Skill File Updates

### Task 1: Create UI designer role skill

**Files:**
- Create: `.claude/skills/roles/ui-designer/SKILL.md`

- [ ] **Step 1: Write the UI designer role skill**

Create `.claude/skills/roles/ui-designer/SKILL.md` with this exact content:

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

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/roles/ui-designer/SKILL.md
git commit -m "feat: add ui-designer role skill"
```

---

### Task 2: Update coder role skill

**Files:**
- Modify: `.claude/skills/roles/coder/SKILL.md`

- [ ] **Step 1: Rewrite the coder role skill**

Replace the entire content of `.claude/skills/roles/coder/SKILL.md` with:

```markdown
# Coder Role

You are a **coder** agent. Your job is to implement the app by writing code, running tests, and pushing working code to main.

## Environment Setup

Before starting work:
1. Check GitHub credentials: `gh auth status`
2. Identify the repository: `git remote -v`
3. Check the current branch and status: `git status`
4. Read CLAUDE.md and any project conventions

## Workflow

1. **Receive a task** — from the initial prompt or a room message
2. **Work on main** — implement the changes directly on the main branch
3. **Run tests and lint** — ensure nothing is broken
4. **Commit and push** — meaningful commit messages, push to origin/main

## Completion

After all work is done (code committed to main, pushed to GitHub):
1. Send `@room DONE: App is ready. Repo: <github-repo-url>. Summary: <brief description of what was built>`
2. Wait for reviewer feedback via room messages
3. Address feedback by pushing fixes to main and notifying the reviewer

## Interaction with Reviewer

- When you receive review feedback, respond to the message first, then address each comment:
  - Fix each issue in code
  - Push the fixes to main
  - Notify the reviewer that fixes are pushed
- **The loop**: code → push → review feedback → fix → push → notify → re-review

## Boundaries

- Do NOT skip tests — always run the test suite before pushing
- Do NOT make changes outside the scope of the task
- Use `@room GATE:` if requirements are ambiguous or you need human clarification
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/roles/coder/SKILL.md
git commit -m "feat: update coder role skill — commit to main, add DONE signal"
```

---

### Task 3: Update reviewer role skill

**Files:**
- Modify: `.claude/skills/roles/reviewer/SKILL.md`

- [ ] **Step 1: Rewrite the reviewer role skill**

Replace the entire content of `.claude/skills/roles/reviewer/SKILL.md` with:

```markdown
# Reviewer Role

You are a **code reviewer** agent. Your job is to review code for correctness, quality, security, and adherence to project standards.

## Environment Setup

Before starting work:
1. Check GitHub credentials: `gh auth status`
2. Identify the repository: `git remote -v`
3. Read CLAUDE.md and any project conventions to understand coding standards

## Wait for Work

When you join a room with a coder and/or UI designer:
- Do NOT start reviewing until you receive a `@room DONE:` message or a direct message with a PR URL
- The coder commits to main and sends `@room DONE:` — clone the repo and review the code on main
- The UI designer creates PRs on branches — review those via `gh pr view` and `gh pr diff`
- If a coder's session ends without DONE, check the room for context and inform the user

## Workflow — Reviewing Coder's Work (on main)

1. **Receive `@room DONE:`** — the coder will include the repo URL
2. **Clone the repo** — `git clone <repo-url> .`
3. **Review the code on main** — check for:
   - Correctness: does the code do what it claims?
   - Security: any vulnerabilities (injection, XSS, auth issues)?
   - Tests: are there adequate tests? Do they cover edge cases?
   - Style: does it follow project conventions?
   - Architecture: is the approach sound?
4. **Send feedback via `@room`** — specific, actionable comments with file:line references
5. **Wait for fixes** — the coder will push to main and notify you
6. **Pull and re-review** — `git pull` and check that feedback was addressed
7. **Approve** — send `@room` confirmation that the code looks good

## Workflow — Reviewing UI Designer's PRs

1. **Receive PR notification** — the UI designer will send a PR URL via `@room`
2. **Fetch PR details** — `gh pr view <number>`, `gh pr diff <number>`
3. **Review the changes** — same criteria as above
4. **Leave review comments** — use `gh pr review <number>` to submit feedback
5. **Notify the UI designer** — send a summary of findings via `@room`
6. **Wait for fixes** — the UI designer will push updates and notify you
7. **Re-review** — check that all feedback was addressed
8. **Approve** — `gh pr review <number> --approve` and notify the room

## Boundaries

- Do NOT modify code yourself — only review and comment
- Do NOT merge PRs — only approve them (let the UI designer merge after approval)
- Be specific in feedback: file, line number, what to change and why
- Focus on substance over style — don't nitpick formatting if a linter handles it
- Use `@room GATE:` if you find a critical issue that needs human decision
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/roles/reviewer/SKILL.md
git commit -m "feat: update reviewer role skill — add wait-for-DONE, dual review workflows"
```

---

### Task 4: Update create-app skill — remove /ui-design invocation, strengthen theme

**Files:**
- Modify: `packages/agent/template/.claude/skills/create-app/SKILL.md`

- [ ] **Step 1: Remove /ui-design invocation from Phase 7**

In `packages/agent/template/.claude/skills/create-app/SKILL.md`, find and remove lines 219-222:

```
Then invoke the UI design skill for interactive refinement:
```
/ui-design
```
```

The Phase 7 section should end after the ARCHITECTURE.md line. The result:

```markdown
## Phase 7: Deploy & Preview

Run migrations and start the dev server:
```bash
pnpm drizzle-kit generate && pnpm drizzle-kit migrate
pnpm dev:start
```

**IMPORTANT**: Always use `pnpm dev:start` from the project directory.

After the app is running, write:
1. `README.md` — overwrite the scaffold README with a project-specific one: app name, one-line description, screenshot placeholder, how to run (`pnpm install && pnpm dev:start`), tech stack (Electric SQL, TanStack DB, Drizzle, TanStack Start), and a brief feature list.
2. `ARCHITECTURE.md` — brief reference: entities, routes, components.

---
```

- [ ] **Step 2: Strengthen theme enforcement in Phase 5**

In the same file, replace Phase 5 (lines 173-183) with:

```markdown
## Phase 5: UI Components

**Before writing UI code**, read the ui-design skill:
- `.claude/skills/ui-design/SKILL.md` — design system, Radix UI Themes component patterns

The `__root.tsx` Theme wrapper MUST use the Electric brand defaults:
```tsx
<Theme accentColor="violet" grayColor="mauve" radius="medium" panelBackground="translucent">
```

Also read the `react-db` and `meta-framework` skills for hook usage and SSR patterns.

Key constraints:
- `ssr: false` on leaf routes that use `useLiveQuery` (NEVER on `__root.tsx`)
- All UI from `@radix-ui/themes` — never raw HTML for interactive elements
- Icons from `lucide-react` only
```

- [ ] **Step 3: Commit**

```bash
git add packages/agent/template/.claude/skills/create-app/SKILL.md
git commit -m "feat: remove /ui-design from create-app, enforce Electric theme in Phase 5"
```

---

### Task 5: Enrich ui-design skill with KPB design philosophy

**Files:**
- Modify: `packages/agent/template/.claude/skills/ui-design/SKILL.md`

- [ ] **Step 1: Add the Design Thinking — Advanced section**

In `packages/agent/template/.claude/skills/ui-design/SKILL.md`, after line 104 (the end of the "Anti-patterns (NEVER do)" section, before "### Import Rules"), insert:

```markdown

### Design Thinking — Advanced

Beyond the baseline Radix patterns, aim for **distinctive, memorable interfaces**:

- **Typography with character**: Work the full typographic range. Use size, weight, and color to establish clear hierarchy. Heading `size="7"` or `size="8"` for page titles creates presence. Pair display-weight headings with lighter body text.
- **Color with conviction**: Dominant colors with sharp accents outperform timid palettes. The violet accent should feel intentional, not decorative. Use contrast to draw the eye.
- **Motion and micro-interactions**: Add subtle transitions for state changes. Focus on high-impact moments — a well-orchestrated page load with staggered reveals creates more delight than scattered animations. Use CSS transitions for hover states.
- **Spatial composition**: Break out of everything-centered layouts. Use asymmetry, `justify="between"` for headers, generous negative space, and visual weight through surfaces. Let content breathe.
- **Atmosphere and depth**: Create visual atmosphere through Card `variant="surface"`, translucent panel backgrounds, and subtle layering. The interface should feel crafted, not generated.
- **Contextual design**: Every app has a different purpose and audience. A task manager feels different from a data dashboard. Match the aesthetic to the domain — colors, density, and component choices should reflect the content.
```

- [ ] **Step 2: Commit**

```bash
git add packages/agent/template/.claude/skills/ui-design/SKILL.md
git commit -m "feat: enrich ui-design skill with KPB design philosophy"
```

---

## Chunk 2: Server-Side — Role Skills Registration & API Schema

### Task 6: Add ui-designer to role-skills.ts

**Files:**
- Modify: `packages/studio/src/bridge/role-skills.ts:19-70`

- [ ] **Step 1: Add ui-designer role aliases**

In `packages/studio/src/bridge/role-skills.ts`, add the new entries to `ROLE_ALIASES` (after line 26):

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
```

- [ ] **Step 2: Add ui-designer tools and update ROLE_TOOLS**

After the `REVIEWER_TOOLS` definition (after line 65), add:

```typescript
/**
 * UI Designer gets full write access — needs Write/Edit/Bash to modify code and run dev server.
 */
const UI_DESIGNER_TOOLS = [...ALL_TOOLS]
```

Update `ROLE_TOOLS` to include the new role:

```typescript
const ROLE_TOOLS: Record<string, string[]> = {
	coder: CODER_TOOLS,
	reviewer: REVIEWER_TOOLS,
	"ui-designer": UI_DESIGNER_TOOLS,
}
```

- [ ] **Step 3: Verify the skill file loads**

Run:

```bash
cd packages/studio && npx tsx -e "
import { resolveRoleSkill } from './src/bridge/role-skills.ts';
const r = resolveRoleSkill('ui-designer');
console.log('role:', r?.roleName);
console.log('tools:', r?.allowedTools?.join(', '));
console.log('content length:', r?.skillContent?.length);
"
```

Expected: `role: ui-designer`, tools list, and content length > 0.

- [ ] **Step 4: Commit**

```bash
git add packages/studio/src/bridge/role-skills.ts
git commit -m "feat: register ui-designer role with full write tools"
```

---

### Task 7: Add createAppRoomSchema to api-schemas.ts

**Files:**
- Modify: `packages/studio/src/api-schemas.ts`

- [ ] **Step 1: Add the new schema**

After the `createRoomSchema` definition (around line 68), add:

```typescript
// POST /api/rooms/create-app
export const createAppRoomSchema = z.object({
	description: z.string().min(1).max(MAX_TEXT),
	name: z.string().max(MAX_SHORT).optional(),
	apiKey: optionalKey,
	oauthToken: optionalKey,
	ghToken: optionalKey,
})
```

- [ ] **Step 2: Commit**

```bash
git add packages/studio/src/api-schemas.ts
git commit -m "feat: add createAppRoomSchema for POST /api/rooms/create-app"
```

---

## Chunk 3: Server-Side — The `POST /api/rooms/create-app` Endpoint

### Task 8: Add the create-app room endpoint to server.ts

**Files:**
- Modify: `packages/studio/src/server.ts`

This is the largest task. The new endpoint orchestrates room creation + 3 agent spawning. It reuses existing patterns from `POST /api/sessions` (for the coder's scaffold setup) and `POST /api/rooms/:id/agents` (for spawning agents into rooms).

- [ ] **Step 1: Add the import for the new schema**

At the top of `server.ts`, find the import from `./api-schemas.js` and add `createAppRoomSchema`:

```typescript
import {
	// ... existing imports ...
	createAppRoomSchema,
} from "./api-schemas.js"
```

- [ ] **Step 2: Add the endpoint**

Add the new endpoint **before** the existing `app.post("/api/rooms", ...)` handler (around line 1957). The endpoint should be placed in the rooms section of the server.

The endpoint follows this flow:
1. Validate request body with `createAppRoomSchema`
2. Rate-limit (1 room = 1 unit, reuse existing `checkSessionRateLimit`)
3. Create room (RoomRouter + durable stream + registry)
4. Return `{ roomId, roomToken }` immediately
5. Run async flow:
   a. Wait for infra config gate (emit on coder's session stream — RoomPage will show it)
   b. Create GitHub repo (prod mode)
   c. Spawn coder agent (full scaffold setup — same as `POST /api/sessions`)
   d. Spawn reviewer agent (minimal sandbox)
   e. Spawn UI designer agent (minimal sandbox)
   f. Add all 3 to the room

Here is the full endpoint code to add:

```typescript
// Create a multi-agent room for app building
app.post("/api/rooms/create-app", async (c) => {
	const body = await validateBody(c, createAppRoomSchema)
	if (isResponse(body)) return body

	// In prod mode, use server-side API key
	const apiKey = config.devMode ? body.apiKey : process.env.ANTHROPIC_API_KEY
	const oauthToken = config.devMode ? body.oauthToken : undefined
	const ghToken = config.devMode ? body.ghToken : undefined

	// Rate-limit at room level (1 room = 1 unit)
	if (!config.devMode) {
		const ip = extractClientIp(c)
		if (!checkSessionRateLimit(ip)) {
			return c.json({ error: "Too many sessions. Please try again later." }, 429)
		}
		if (checkGlobalSessionCap(config.sessions)) {
			return c.json({ error: "Service at capacity, please try again later" }, 503)
		}
	}

	// --- Create the room ---
	const roomId = crypto.randomUUID()
	const roomName = body.description.slice(0, 60).trim() || "App Builder"

	const roomConn = roomStream(config, roomId)
	try {
		await DurableStream.create({
			url: roomConn.url,
			headers: roomConn.headers,
			contentType: "application/json",
		})
	} catch (err) {
		console.error(`[room:create-app] Failed to create room stream:`, err)
		return c.json({ error: "Failed to create room stream" }, 500)
	}

	const router = new RoomRouter(roomId, roomName, config.streamConfig, {})
	await router.start()
	roomRouters.set(roomId, router)

	const code = generateInviteCode()
	await config.rooms.addRoom({
		id: roomId,
		code,
		name: roomName,
		createdAt: new Date().toISOString(),
		revoked: false,
	})

	const roomToken = deriveRoomToken(config.streamConfig.secret, roomId)
	console.log(`[room:create-app] Created room: id=${roomId} name=${roomName}`)

	// --- Create 3 session IDs upfront ---
	const coderSessionId = crypto.randomUUID()
	const reviewerSessionId = crypto.randomUUID()
	const uiDesignerSessionId = crypto.randomUUID()

	const inferredName = config.devMode
		? body.name ||
			body.description
				.slice(0, 40)
				.replace(/[^a-z0-9]+/gi, "-")
				.replace(/^-|-$/g, "")
				.toLowerCase()
		: `electric-${coderSessionId.slice(0, 8)}`

	const baseDir = process.cwd()
	const { projectName } = resolveProjectDir(baseDir, inferredName)

	// Create session streams for all 3 agents
	for (const sid of [coderSessionId, reviewerSessionId, uiDesignerSessionId]) {
		const conn = sessionStream(config, sid)
		try {
			await DurableStream.create({
				url: conn.url,
				headers: conn.headers,
				contentType: "application/json",
			})
		} catch (err) {
			console.error(`[room:create-app] Failed to create session stream for ${sid}:`, err)
			return c.json({ error: "Failed to create session streams" }, 500)
		}
	}

	// Register all 3 sessions
	const coderBridge = getOrCreateBridge(config, coderSessionId)
	const reviewerBridge = getOrCreateBridge(config, reviewerSessionId)
	const uiDesignerBridge = getOrCreateBridge(config, uiDesignerSessionId)

	const coderProjectDir = `/home/agent/workspace/${projectName}`
	const reviewerProjectDir = `/home/agent/workspace/reviewer-${projectName}`
	const uiDesignerProjectDir = `/home/agent/workspace/ui-designer-${projectName}`

	for (const [sid, desc, projDir] of [
		[coderSessionId, `Coder: ${body.description}`, coderProjectDir],
		[reviewerSessionId, `Reviewer: ${body.description}`, reviewerProjectDir],
		[uiDesignerSessionId, `UI Designer: ${body.description}`, uiDesignerProjectDir],
	] as const) {
		config.sessions.add({
			id: sid,
			projectName,
			sandboxProjectDir: projDir,
			description: desc,
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: "running",
		})
	}

	// Write user prompt to coder stream
	await coderBridge.emit({ type: "user_prompt", message: body.description, ts: ts() })

	// Return immediately — the async flow below spawns sandboxes
	const response = c.json(
		{
			roomId,
			roomToken,
			sessions: {
				coder: coderSessionId,
				reviewer: reviewerSessionId,
				uiDesigner: uiDesignerSessionId,
			},
		},
		201,
	)

	// --- Async flow: infra gate → sandbox creation → agent startup ---
	const asyncFlow = async () => {
		// 1. Infra config gate (on coder's stream, same as single-session flow)
		let infra: InfraConfig
		let repoConfig: {
			account: string
			repoName: string
			visibility: "public" | "private"
		} | null = null
		let claimId: string | undefined

		// Gather GitHub accounts (dev mode only)
		let ghAccounts: { login: string; type: "user" | "org" }[] = []
		if (config.devMode && ghToken && isGhAuthenticated(ghToken)) {
			try {
				ghAccounts = ghListAccounts(ghToken)
			} catch {
				// gh not available
			}
		}

		// Emit infra config gate on coder's session stream
		await coderBridge.emit({
			type: "infra_config_prompt",
			projectName,
			ghAccounts,
			runtime: config.sandbox.runtime,
			ts: ts(),
		})

		console.log(`[room:create-app] Waiting for infra_config gate...`)
		try {
			const gateValue = await createGate<
				InfraConfig & {
					repoAccount?: string
					repoName?: string
					repoVisibility?: "public" | "private"
					claimId?: string
				}
			>(coderSessionId, "infra_config")

			console.log(`[room:create-app] Infra gate resolved: mode=${gateValue.mode}`)

			if (gateValue.mode === "cloud" || gateValue.mode === "claim") {
				infra = {
					mode: "cloud",
					databaseUrl: gateValue.databaseUrl,
					electricUrl: gateValue.electricUrl,
					sourceId: gateValue.sourceId,
					secret: gateValue.secret,
				}
				if (gateValue.mode === "claim") {
					claimId = gateValue.claimId
				}
			} else {
				infra = { mode: "local" }
			}

			if (gateValue.repoAccount && gateValue.repoName?.trim()) {
				repoConfig = {
					account: gateValue.repoAccount,
					repoName: gateValue.repoName,
					visibility: gateValue.repoVisibility ?? "private",
				}
			}
		} catch (err) {
			console.log(`[room:create-app] Infra gate error (defaulting to local):`, err)
			infra = { mode: "local" }
		}

		// 2. Create all 3 sandboxes in parallel
		await coderBridge.emit({
			type: "log",
			level: "build",
			message: "Creating sandboxes for all agents...",
			ts: ts(),
		})

		const sandboxOpts = {
			infra: { mode: "local" as const },
			apiKey,
			oauthToken,
			ghToken,
			...(!config.devMode && {
				prodMode: {
					sessionToken: deriveSessionToken(config.streamConfig.secret, coderSessionId),
					studioUrl: resolveStudioUrl(config.port),
				},
			}),
		}

		// Spawn sandboxes — coder gets full infra, reviewer/ui-designer get minimal
		const [coderHandle, reviewerHandle, uiDesignerHandle] = await Promise.all([
			config.sandbox.create(coderSessionId, {
				...sandboxOpts,
				projectName,
				infra,
				...(!config.devMode && {
					prodMode: {
						sessionToken: deriveSessionToken(config.streamConfig.secret, coderSessionId),
						studioUrl: resolveStudioUrl(config.port),
					},
				}),
			}),
			config.sandbox.create(reviewerSessionId, {
				...sandboxOpts,
				projectName: `reviewer-${projectName}`,
				...(!config.devMode && {
					prodMode: {
						sessionToken: deriveSessionToken(config.streamConfig.secret, reviewerSessionId),
						studioUrl: resolveStudioUrl(config.port),
					},
				}),
			}),
			config.sandbox.create(uiDesignerSessionId, {
				...sandboxOpts,
				projectName: `ui-designer-${projectName}`,
				...(!config.devMode && {
					prodMode: {
						sessionToken: deriveSessionToken(config.streamConfig.secret, uiDesignerSessionId),
						studioUrl: resolveStudioUrl(config.port),
					},
				}),
			}),
		])

		// Update session records with sandbox info
		config.sessions.update(coderSessionId, {
			appPort: coderHandle.port,
			sandboxProjectDir: coderHandle.projectDir,
			previewUrl: coderHandle.previewUrl,
			...(claimId ? { claimId } : {}),
		})
		config.sessions.update(reviewerSessionId, {
			appPort: reviewerHandle.port,
			sandboxProjectDir: reviewerHandle.projectDir,
			previewUrl: reviewerHandle.previewUrl,
		})
		config.sessions.update(uiDesignerSessionId, {
			appPort: uiDesignerHandle.port,
			sandboxProjectDir: uiDesignerHandle.projectDir,
			previewUrl: uiDesignerHandle.previewUrl,
		})

		await coderBridge.emit({
			type: "log",
			level: "done",
			message: "All sandboxes ready",
			ts: ts(),
		})

		// 3. Set up coder sandbox (full scaffold — same as POST /api/sessions)
		if (config.sandbox.runtime === "docker") {
			await config.sandbox.exec(coderHandle, `cp -r /opt/scaffold-base '${coderHandle.projectDir}'`)
			await config.sandbox.exec(
				coderHandle,
				`cd '${coderHandle.projectDir}' && sed -i 's/"name": "scaffold-base"/"name": "${projectName.replace(/[^a-z0-9_-]/gi, "-")}"/' package.json`,
			)
		} else {
			await config.sandbox.exec(
				coderHandle,
				`source /etc/profile.d/npm-global.sh 2>/dev/null; electric-agent scaffold '${coderHandle.projectDir}' --name '${projectName}' --skip-git`,
			)
		}

		// Create GitHub repo (prod mode)
		let repoUrl: string | undefined
		let prodGitConfig: { mode: "pre-created"; repoName: string; repoUrl: string } | undefined
		if (!config.devMode && GITHUB_APP_ID && GITHUB_INSTALLATION_ID && GITHUB_PRIVATE_KEY) {
			try {
				const repoSlug = projectName
				await coderBridge.emit({
					type: "log",
					level: "build",
					message: "Creating GitHub repository...",
					ts: ts(),
				})
				const { token } = await getInstallationToken(
					GITHUB_APP_ID,
					GITHUB_INSTALLATION_ID,
					GITHUB_PRIVATE_KEY,
				)
				const repo = await createOrgRepo(GITHUB_ORG, repoSlug, token)
				if (repo) {
					const actualRepoName = `${GITHUB_ORG}/${repo.htmlUrl.split("/").pop()}`
					repoUrl = repo.htmlUrl
					await config.sandbox.exec(
						coderHandle,
						`cd '${coderHandle.projectDir}' && git init -b main && git remote add origin '${repo.cloneUrl}'`,
					)
					prodGitConfig = {
						mode: "pre-created" as const,
						repoName: actualRepoName,
						repoUrl: repo.htmlUrl,
					}
					config.sessions.update(coderSessionId, {
						git: {
							branch: "main",
							remoteUrl: repo.htmlUrl,
							repoName: actualRepoName,
							lastCommitHash: null,
							lastCommitMessage: null,
							lastCheckpointAt: null,
						},
					})
					await coderBridge.emit({
						type: "log",
						level: "done",
						message: `GitHub repo created: ${repo.htmlUrl}`,
						ts: ts(),
					})
				}
			} catch (err) {
				console.error(`[room:create-app] GitHub repo creation error:`, err)
				await coderBridge.emit({
					type: "log",
					level: "error",
					message: "GitHub repo creation failed — coder will work locally",
					ts: ts(),
				})
			}
		} else if (repoConfig) {
			// Dev mode with user-configured repo
			repoUrl = `https://github.com/${repoConfig.account}/${repoConfig.repoName}`
		}

		// Write CLAUDE.md to coder sandbox
		const claudeMd = generateClaudeMd({
			description: body.description,
			projectName,
			projectDir: coderHandle.projectDir,
			runtime: config.sandbox.runtime,
			production: !config.devMode,
			...(prodGitConfig
				? { git: prodGitConfig }
				: repoConfig
					? {
							git: {
								mode: "create" as const,
								repoName: `${repoConfig.account}/${repoConfig.repoName}`,
								visibility: repoConfig.visibility,
							},
						}
					: {}),
		})
		try {
			await config.sandbox.exec(
				coderHandle,
				`cat > '${coderHandle.projectDir}/CLAUDE.md' << 'CLAUDEMD_EOF'\n${claudeMd}\nCLAUDEMD_EOF`,
			)
		} catch (err) {
			console.error(`[room:create-app] Failed to write CLAUDE.md:`, err)
		}

		// Write create-app skill to coder sandbox
		if (createAppSkillContent) {
			try {
				const skillDir = `${coderHandle.projectDir}/.claude/skills/create-app`
				const skillB64 = Buffer.from(createAppSkillContent).toString("base64")
				await config.sandbox.exec(
					coderHandle,
					`mkdir -p '${skillDir}' && echo '${skillB64}' | base64 -d > '${skillDir}/SKILL.md'`,
				)
			} catch (err) {
				console.error(`[room:create-app] Failed to write create-app skill:`, err)
			}
		}

		// 4. Inject room-messaging skill + role skills into all 3 sandboxes
		const allHandles = [
			{ sid: coderSessionId, handle: coderHandle, role: "coder", name: "coder" },
			{ sid: reviewerSessionId, handle: reviewerHandle, role: "reviewer", name: "reviewer" },
			{ sid: uiDesignerSessionId, handle: uiDesignerHandle, role: "ui-designer", name: "ui-designer" },
		]

		for (const { handle, role } of allHandles) {
			// Room-messaging skill
			if (roomMessagingSkillContent) {
				try {
					const skillDir = `${handle.projectDir}/.claude/skills/room-messaging`
					const skillB64 = Buffer.from(roomMessagingSkillContent).toString("base64")
					await config.sandbox.exec(
						handle,
						`mkdir -p '${skillDir}' && echo '${skillB64}' | base64 -d > '${skillDir}/SKILL.md'`,
					)
					const roomRef = `\n\n## Room Messaging (CRITICAL)\nYou are a participant in a multi-agent room. Read .claude/skills/room-messaging/SKILL.md for the messaging protocol.\nAll communication with other agents MUST use @room or @<name> messages as described in that skill.\n`
					const refB64 = Buffer.from(roomRef).toString("base64")
					await config.sandbox.exec(
						handle,
						`echo '${refB64}' | base64 -d >> '${handle.projectDir}/CLAUDE.md'`,
					)
				} catch (err) {
					console.error(`[room:create-app] Failed to write room-messaging skill:`, err)
				}
			}

			// Role skill
			const roleSkill = resolveRoleSkill(role)
			if (roleSkill) {
				try {
					const skillDir = `${handle.projectDir}/.claude/skills/role`
					const skillB64 = Buffer.from(roleSkill.skillContent).toString("base64")
					await config.sandbox.exec(
						handle,
						`mkdir -p '${skillDir}' && echo '${skillB64}' | base64 -d > '${skillDir}/SKILL.md'`,
					)
				} catch (err) {
					console.error(`[room:create-app] Failed to write role skill for ${role}:`, err)
				}
			}
		}

		// 5. Create Claude Code bridges for all 3 agents
		const repoUrlSuffix = repoUrl ? ` The GitHub repo is: ${repoUrl}` : ""

		const agentConfigs: Array<{
			sid: string
			name: string
			role: string
			handle: typeof coderHandle
			bridge: SessionBridge
			prompt: string
		}> = [
			{
				sid: coderSessionId,
				name: "coder",
				role: "coder",
				handle: coderHandle,
				bridge: coderBridge,
				prompt: `/create-app ${body.description}`,
			},
			{
				sid: reviewerSessionId,
				name: "reviewer",
				role: "reviewer",
				handle: reviewerHandle,
				bridge: reviewerBridge,
				prompt: `You are "reviewer", a code review agent in a multi-agent room. Read .claude/skills/role/SKILL.md for your role guidelines.${repoUrlSuffix} Wait for the coder to send a @room DONE: message before starting any work.`,
			},
			{
				sid: uiDesignerSessionId,
				name: "ui-designer",
				role: "ui-designer",
				handle: uiDesignerHandle,
				bridge: uiDesignerBridge,
				prompt: `You are "ui-designer", a UI design agent in a multi-agent room. Read .claude/skills/role/SKILL.md for your role guidelines.${repoUrlSuffix} Wait for the coder to send a @room DONE: message before starting any work.`,
			},
		]

		let coderCcBridge: ReturnType<typeof createClaudeCodeBridge> | undefined

		for (const agent of agentConfigs) {
			const roleSkill = resolveRoleSkill(agent.role)
			const hookToken = deriveHookToken(config.streamConfig.secret, agent.sid)
			const claudeConfig: ClaudeCodeDockerConfig | ClaudeCodeSpritesConfig =
				config.sandbox.runtime === "sprites"
					? {
							prompt: agent.prompt,
							cwd: agent.handle.projectDir,
							studioUrl: resolveStudioUrl(config.port),
							hookToken,
							agentName: agent.name,
							...(roleSkill?.allowedTools && { allowedTools: roleSkill.allowedTools }),
						}
					: {
							prompt: agent.prompt,
							cwd: agent.handle.projectDir,
							studioPort: config.port,
							hookToken,
							agentName: agent.name,
							...(roleSkill?.allowedTools && { allowedTools: roleSkill.allowedTools }),
						}

			const ccBridge = createClaudeCodeBridge(config, agent.sid, claudeConfig)

			if (agent.name === "coder") {
				coderCcBridge = ccBridge
			}

			// Track cost + session ID
			ccBridge.onAgentEvent((event) => {
				if (event.type === "session_start") {
					const ccSessionId = (event as EngineEvent & { session_id?: string }).session_id
					if (ccSessionId) {
						config.sessions.update(agent.sid, { lastCoderSessionId: ccSessionId })
					}
				}
				if (event.type === "session_end") {
					accumulateSessionCost(config, agent.sid, event)
				}
				// Route messages to room
				if (event.type === "assistant_message" && "text" in event) {
					router
						.handleAgentOutput(agent.sid, (event as EngineEvent & { text: string }).text)
						.catch((err) => {
							console.error(`[room:create-app] handleAgentOutput error:`, err)
						})
				}
			})

			ccBridge.onComplete(async (success) => {
				config.sessions.update(agent.sid, {
					status: success ? "complete" : "error",
				})

				// If coder ends, check app status and notify room on failure
				if (agent.name === "coder") {
					if (success) {
						try {
							const appRunning = await config.sandbox.isAppRunning(agent.handle)
							if (appRunning) {
								await agent.bridge.emit({
									type: "app_status",
									status: "running",
									port: agent.handle.port,
									previewUrl: agent.handle.previewUrl,
									ts: ts(),
								})
							}
						} catch {
							// Container may already be stopped
						}
					} else {
						// Coder failed — notify room so reviewer/ui-designer can react
						try {
							await router.handleAgentOutput(
								agent.sid,
								"@room Coder session ended unexpectedly. No DONE signal was sent. Check the room for context.",
							)
						} catch {
							// Best effort
						}
					}
				}
			})

			await agent.bridge.emit({
				type: "log",
				level: "done",
				message: `Sandbox ready for "${agent.name}"`,
				ts: ts(),
			})

			await ccBridge.start()

			// Add participant to room
			const participant: RoomParticipant = {
				sessionId: agent.sid,
				name: agent.name,
				role: agent.role,
				bridge: ccBridge,
			}
			await router.addParticipant(participant, false)
		}

		// Show the command being sent to Claude Code
		await coderBridge.emit({
			type: "log",
			level: "build",
			message: `Running: claude "/create-app ${body.description}"`,
			ts: ts(),
		})
	}

	asyncFlow().catch(async (err) => {
		console.error(`[room:create-app] Room creation flow failed:`, err)
		for (const sid of [coderSessionId, reviewerSessionId, uiDesignerSessionId]) {
			config.sessions.update(sid, { status: "error" })
		}
		try {
			await coderBridge.emit({
				type: "log",
				level: "error",
				message: `Room creation failed: ${err instanceof Error ? err.message : String(err)}`,
				ts: ts(),
			})
		} catch {
			// Bridge may not be usable
		}
	})

	return response
})
```

**Important notes for the implementer:**
- This endpoint must be placed **before** the existing room auth middleware that checks `X-Room-Token` headers, since this endpoint creates a new room and returns the token.
- The `RoomParticipant`, `InfraConfig`, `EngineEvent`, `ClaudeCodeDockerConfig`, `ClaudeCodeSpritesConfig`, `SessionInfo`, `SessionBridge` types are already imported/used in server.ts.
- The functions `roomStream`, `sessionStream`, `DurableStream`, `RoomRouter`, `generateInviteCode`, `deriveRoomToken`, `deriveSessionToken`, `deriveHookToken`, `resolveStudioUrl`, `createGate`, `getOrCreateBridge`, `createClaudeCodeBridge`, `resolveProjectDir`, `generateClaudeMd`, `createAppSkillContent`, `roomMessagingSkillContent`, `resolveRoleSkill`, `accumulateSessionCost`, `ts`, `isGhAuthenticated`, `ghListAccounts`, `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_ORG`, `getInstallationToken`, `createOrgRepo` are all already available in scope in server.ts.
- The `roomRouters` Map is already defined at the top of the server scope.

- [ ] **Step 2: Build to check for type errors**

```bash
cd packages/studio && pnpm run build
```

Expected: Build succeeds with no errors. Fix any type issues.

- [ ] **Step 3: Commit**

```bash
git add packages/studio/src/server.ts
git commit -m "feat: add POST /api/rooms/create-app endpoint for multi-agent app creation"
```

---

## Chunk 4: Client-Side Changes

### Task 9: Add createAppRoom to api.ts

**Files:**
- Modify: `packages/studio/client/src/lib/api.ts`

- [ ] **Step 1: Add the new API function**

After the existing `createSession` function (around line 177), add:

```typescript
export async function createAppRoom(description: string, name?: string) {
	const result = await request<{
		roomId: string
		roomToken: string
		sessions: { coder: string; reviewer: string; uiDesigner: string }
	}>("/rooms/create-app", {
		method: "POST",
		body: { description, name, ...credentialFields() },
	})
	if (result.roomToken) {
		setRoomToken(result.roomId, result.roomToken)
	}
	return result
}
```

Check if `setRoomToken` exists. If not, look at how `setSessionToken` works in `session-store.ts` and create the equivalent for rooms.

- [ ] **Step 2: Commit**

```bash
git add packages/studio/client/src/lib/api.ts
git commit -m "feat: add createAppRoom client API function"
```

---

### Task 10: Extend AgentRoomEntry with session IDs

**Files:**
- Modify: `packages/studio/client/src/lib/agent-room-store.ts`

- [ ] **Step 1: Add sessions field to AgentRoomEntry**

Update the interface:

```typescript
export interface AgentRoomEntry {
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

No other changes needed — `addAgentRoom` already accepts an `AgentRoomEntry` and serializes it.

- [ ] **Step 2: Commit**

```bash
git add packages/studio/client/src/lib/agent-room-store.ts
git commit -m "feat: extend AgentRoomEntry with session IDs"
```

---

### Task 11: Update AppShell navigation for non-freeform

**Files:**
- Modify: `packages/studio/client/src/layouts/AppShell.tsx:179-186`

- [ ] **Step 1: Change handleNewProject**

Replace the current `handleNewProject` (lines 179-188):

```typescript
const handleNewProject = useCallback(
	(description: string, freeform?: boolean) => {
		const words = description.split(/\s+/).slice(0, 3).join(" ")
		setPendingProject({ name: words || "New project" })
		if (freeform) {
			navigate("/session/new", { state: { description, freeform } })
		} else {
			navigate("/room/new", { state: { description } })
		}
	},
	[navigate],
)
```

- [ ] **Step 2: Commit**

```bash
git add packages/studio/client/src/layouts/AppShell.tsx
git commit -m "feat: route non-freeform projects to /room/new"
```

---

### Task 12: Add /room/new handling to RoomPage + ui-designer role

**Files:**
- Modify: `packages/studio/client/src/pages/RoomPage.tsx`

- [ ] **Step 1: Add ui-designer to BUILT_IN_ROLES**

Find the `BUILT_IN_ROLES` array (around line 471) and add:

```typescript
const BUILT_IN_ROLES = [
	{ value: "coder", label: "Coder", description: "Writes code, creates PRs" },
	{ value: "reviewer", label: "Reviewer", description: "Reviews PRs (read-only)" },
	{ value: "ui-designer", label: "UI Designer", description: "Audits and improves UI" },
] as const
```

- [ ] **Step 2: Add /room/new creation logic**

At the top of the `RoomPage` component, add the room creation flow similar to how `SessionPage` handles `id === "new"`. Add these imports and state:

```typescript
import { createAppRoom } from "../lib/api"
import { addAgentRoom } from "../lib/agent-room-store"
```

Inside the `RoomPage` component, after `const { id: roomId } = useParams<{ id: string }>()`, add:

```typescript
const location = useLocation()
const [creating, setCreating] = useState(false)
const creatingRef = useRef(false)

useEffect(() => {
	if (roomId !== "new" || creatingRef.current) return
	const state = location.state as { description?: string } | null
	if (!state?.description) {
		navigate("/", { replace: true })
		return
	}
	creatingRef.current = true
	setCreating(true)

	createAppRoom(state.description)
		.then(({ roomId: newRoomId, roomToken, sessions }) => {
			addAgentRoom({
				id: newRoomId,
				code: "",
				name: state.description!.slice(0, 60),
				createdAt: new Date().toISOString(),
				sessions,
			})
			refreshSessions()
			setCreating(false)
			navigate(`/room/${newRoomId}`, { replace: true })
		})
		.catch((err) => {
			console.error("Failed to create app room:", err)
			navigate("/", { replace: true })
		})
}, [roomId, location.state, navigate, refreshSessions])
```

Also add `useLocation` to the react-router-dom import.

Early return if creating:

```typescript
if (roomId === "new" || creating) {
	return <div className="room-page"><div className="room-loading">Creating multi-agent room...</div></div>
}
```

- [ ] **Step 3: Build to verify**

```bash
cd packages/studio && pnpm run build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/studio/client/src/pages/RoomPage.tsx
git commit -m "feat: handle /room/new creation flow, add ui-designer to BUILT_IN_ROLES"
```

---

## Chunk 5: Build, Lint & Integration Test

### Task 13: Full build and lint

**Files:** None (verification only)

- [ ] **Step 1: Run pnpm check:fix across the monorepo**

```bash
pnpm check:fix
```

Fix any lint/formatting issues.

- [ ] **Step 2: Build all packages**

```bash
pnpm run build
```

Fix any type errors.

- [ ] **Step 3: Commit any formatting/lint fixes**

```bash
git add -A
git commit -m "chore: fix lint and formatting"
```

---

### Task 14: Manual integration test with Docker

- [ ] **Step 1: Start the dev server**

```bash
SANDBOX_RUNTIME=docker pnpm run serve
```

- [ ] **Step 2: Open the UI in a browser**

Navigate to `http://127.0.0.1:4400` (or the configured port).

- [ ] **Step 3: Test the non-freeform flow**

1. Type an app description (e.g., "A task management app with projects and tasks")
2. Verify navigation goes to `/room/new` then redirects to `/room/{roomId}`
3. Verify the infra config gate appears (Docker selection)
4. Select Docker and proceed
5. Verify 3 agents appear as participants in the room view
6. Verify the coder starts building the app
7. Verify the reviewer and UI designer are idle (waiting for DONE)

- [ ] **Step 4: Test the freeform flow still works**

1. Enable freeform mode (if in dev mode)
2. Submit a freeform prompt
3. Verify it goes to `/session/new` → `/session/{id}` (single session, no room)

- [ ] **Step 5: Create a changeset**

Create `.changeset/multi-agent-room-workflow.md`:

```markdown
---
"@electric-agent/studio": minor
---

Add multi-agent room-based app creation workflow. Non-freeform app descriptions now create a room with 3 agents (coder, reviewer, UI designer) that collaborate via room messages and GitHub.
```

- [ ] **Step 6: Commit**

```bash
git add .changeset/multi-agent-room-workflow.md
git commit -m "chore: add changeset for multi-agent room workflow"
```
