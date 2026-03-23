# TUI/WebUI Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the TUI so its session lifecycle, room flow, and agent peek match the WebUI — both UIs consume the same durable streams through the shared protocol client.

**Architecture:** The TUI already uses `ElectricAgentClient` from `@electric-agent/protocol/client` while the WebUI has a parallel `api.ts` with nearly identical logic. We fix the TUI's default flow (room-first instead of session-first), fix agent peek, then migrate the WebUI to use the same protocol client — achieving a single API surface consumed by both UIs.

**Tech Stack:** TypeScript, Ink (React for CLI), `@electric-agent/protocol/client`, SSE via fetch (TUI) and EventSource (WebUI)

---

## Diagnosis Summary

| Issue | Root Cause |
|-------|-----------|
| TUI jumps straight to coder agent | `HomeScreen.handleSubmit` calls `onCreateSession` (standalone session). WebUI calls `createAppRoom` by default. |
| No room messages visible in TUI | Standalone sessions have no room — no `RoomEvent` stream to consume |
| Agents peek broken | Untested path — TUI rarely creates rooms. May also have rendering issues in `AgentConsoleView` |
| Duplicate API implementations | WebUI `api.ts` duplicates `ElectricAgentClient` logic with browser-specific token store (localStorage) |

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/tui/src/screens/HomeScreen.tsx` | Modify | Default submit → room creation, add `[R]`/`[F]` mode switching |
| `packages/tui/src/app.tsx` | Modify | Default flow calls `handleCreateRoom`, wire freeform fallback |
| `packages/tui/src/screens/RoomScreen.tsx` | Modify | Fix `AgentConsoleView` rendering, add gate forwarding for peeked agents |
| `packages/tui/src/hooks/useSessionStream.ts` | Modify | Add error state + reconnection feedback |
| `packages/protocol/src/client.ts` | Modify | Add missing methods (`fetchGhAccounts`, `provisionElectric`, etc.) needed by WebUI |
| `packages/studio/client/src/lib/api.ts` | Modify | Replace with thin wrapper around `ElectricAgentClient` |
| `packages/studio/client/src/hooks/useSession.ts` | Modify | Replace `EventSource` with protocol client's `sessionEvents()` |
| `packages/studio/client/src/hooks/useRoomEvents.ts` | Modify | Replace custom SSE with protocol client's `roomEvents()` |

---

## Phase 1: Fix TUI Default Flow (Room-First)

### Task 1: Make HomeScreen default to room creation

**Files:**
- Modify: `packages/tui/src/screens/HomeScreen.tsx`
- Modify: `packages/tui/src/app.tsx`

The WebUI's `handleNewProject` (AppShell.tsx:178-191) defaults to `navigate("/room/new")` → `createAppRoom()`. Only freeform sessions use `createSession()`. The TUI must match this.

- [ ] **Step 1: Update HomeScreen to support mode switching**

In `HomeScreen.tsx`, change `handleSubmit` to call `onCreateRoom` by default, and add a `[F]` hotkey to toggle freeform mode:

```tsx
// HomeScreen.tsx — modify handleSubmit
const [freeform, setFreeform] = useState(false)

const handleSubmit = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) {
        if (recentSessions.length > 0) {
            setMode("browse")
            setBrowseIndex(0)
        }
        return
    }
    if (freeform) {
        onCreateSession(trimmed)
    } else {
        onCreateRoom(trimmed)
    }
    setInput("")
}
```

Add a `Ctrl+T` keybinding in the prompt-mode `useInput` to toggle `freeform` (NOTE: `Ctrl+F` conflicts with the global tab-switch keybinding in `app.tsx:415`):

```tsx
useInput(
    (input, key) => {
        if (key.downArrow && recentSessions.length > 0) {
            setMode("browse")
            setBrowseIndex(0)
        }
        // Ctrl+T toggles freeform/room mode
        if (key.ctrl && input === "t") {
            setFreeform((v) => !v)
        }
    },
    { isActive: isActive && mode === "prompt" && !inputDisabled },
)
```

Update the prompt label to show the current mode:

```tsx
<Text>
    {freeform
        ? "Describe what you want (freeform session):"
        : "Describe the app you want to build:"}
</Text>
```

Add a mode indicator below the input showing the **current** mode (and what key switches it):

```tsx
<Box marginTop={1} gap={2}>
    <Text dimColor>
        Mode: {freeform ? "freeform" : "room"} [^T toggle]
    </Text>
    <Text dimColor>[^J join room]</Text>
</Box>
```

- [ ] **Step 2: Add join-room hotkey (`Ctrl+J`)**

Add `Ctrl+J` to switch to join mode in the prompt-mode `useInput`:

```tsx
if (key.ctrl && input === "j") {
    setMode("join")
}
```

- [ ] **Step 3: Verify the app.tsx wiring is correct**

`app.tsx` already has `handleCreateRoom` wired to `HomeScreen.onCreateRoom`. Verify no changes needed — the prop is already passed. Confirm by reading lines 503-514 of app.tsx (HomeScreen usage).

- [ ] **Step 4: Build and verify**

Run: `cd packages/tui && pnpm tsc --noEmit`
Expected: Clean compile

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/screens/HomeScreen.tsx
git commit -m "fix(tui): default to room creation matching webui flow"
```

---

### Task 2: Add stored rooms to HomeScreen's recent list

**Files:**
- Modify: `packages/tui/src/screens/HomeScreen.tsx`
- Modify: `packages/tui/src/app.tsx`

Currently HomeScreen only shows recent sessions. The WebUI sidebar shows both sessions and rooms. The TUI should show rooms in the recent list too.

- [ ] **Step 1: Pass rooms to HomeScreen**

In `app.tsx`, load stored rooms and pass them:

```tsx
// In App component, add state for rooms
const [storedRooms, setStoredRooms] = useState(() => loadRooms())

// Pass to HomeScreen
<HomeScreen
    sessions={sessions}
    rooms={storedRooms}
    onSelectRoom={(roomId, roomName) => {
        addScreen({ type: "room", roomId, roomName })
    }}
    // ... existing props
/>
```

- [ ] **Step 2: Display rooms in HomeScreen**

In `HomeScreen.tsx`, add a `rooms` prop and merge into the recent list:

```tsx
interface HomeScreenProps {
    // ... existing
    rooms?: Array<{ id: string; name: string; createdAt: string }>
    onSelectRoom?: (id: string, name?: string) => void
}

// Merge into recentItems for display
// Use the existing StoredRoom type from session-store.ts
import type { StoredRoom } from "../lib/session-store.js"

type RecentItem =
    | { type: "session"; session: SessionInfo }
    | { type: "room"; room: StoredRoom }

const recentItems: RecentItem[] = [
    ...sessions.map((s) => ({ type: "session" as const, session: s })),
    ...(rooms ?? []).map((r) => ({ type: "room" as const, room: r })),
]
    .sort((a, b) => {
        const aTime = a.type === "session" ? a.session.lastActiveAt : a.room.createdAt
        const bTime = b.type === "session" ? b.session.lastActiveAt : b.room.createdAt
        return new Date(bTime).getTime() - new Date(aTime).getTime()
    })
    .slice(0, 10)
```

Update browse-mode selection to handle both types:

```tsx
if (key.return) {
    const item = recentItems[browseIndex]
    if (item?.type === "session") onSelectSession(item.session.id)
    else if (item?.type === "room") onSelectRoom?.(item.room.id, item.room.name)
    return
}
```

- [ ] **Step 3: Build and verify**

Run: `cd packages/tui && pnpm tsc --noEmit`
Expected: Clean compile

- [ ] **Step 4: Commit**

```bash
git add packages/tui/src/screens/HomeScreen.tsx packages/tui/src/app.tsx
git commit -m "feat(tui): show rooms in recent list, allow reopening"
```

---

## Phase 2: Fix Agents Peek

### Task 3: Debug and fix AgentConsoleView in RoomScreen

**Files:**
- Modify: `packages/tui/src/screens/RoomScreen.tsx`
- Modify: `packages/tui/src/hooks/useSessionStream.ts`

The `AgentConsoleView` component uses `useSessionStream` to subscribe to a peeked agent's session events. Potential issues:
1. No error feedback — if SSE auth fails, user sees blank screen
2. The `Console` component may need `flexGrow={1}` to render properly
3. Gate events from the peeked agent aren't actionable

- [ ] **Step 1: Add error state to useSessionStream**

In `useSessionStream.ts`, add error tracking:

```tsx
const [error, setError] = useState<string | null>(null)

// In the connect function, update the catch:
} catch (err) {
    if (!abort.signal.aborted) {
        setIsLive(false)
        const msg = err instanceof Error ? err.message : "Stream connection failed"
        setError(msg)
    }
}

// Return error in the hook result
return { entries, isLive, isComplete, appStatus, markGateResolved, error }
```

- [ ] **Step 2: Fix AgentConsoleView rendering**

In `RoomScreen.tsx`, fix the `AgentConsoleView` to show errors and use proper layout:

```tsx
function AgentConsoleView({ client, sessionId }: { client: ElectricAgentClient; sessionId: string }) {
    const { entries, isLive, error } = useSessionStream(client, sessionId)
    const consoleEntries = entries.filter((e) => e.kind !== "gate")

    if (error) {
        return (
            <Box flexDirection="column" flexGrow={1} paddingX={1}>
                <Text color="red">Failed to connect to agent stream: {error}</Text>
            </Box>
        )
    }

    if (!isLive && consoleEntries.length === 0) {
        return (
            <Box flexDirection="column" flexGrow={1} paddingX={1}>
                <Text dimColor>Connecting to agent stream...</Text>
            </Box>
        )
    }

    return (
        <Box flexDirection="column" flexGrow={1}>
            <Console entries={consoleEntries} />
        </Box>
    )
}
```

- [ ] **Step 3: Build and verify**

Run: `cd packages/tui && pnpm tsc --noEmit`
Expected: Clean compile

- [ ] **Step 4: Manual test with running server**

Start the server and TUI. Create a room, wait for agents to join, then press `^P` to peek at an agent. Verify:
- Agent selector shows participants
- Selecting an agent shows their console output
- `Esc` returns to room view
- Error state shown if connection fails

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/screens/RoomScreen.tsx packages/tui/src/hooks/useSessionStream.ts
git commit -m "fix(tui): agent peek shows errors and loading state"
```

---

### Task 4: Forward gate events from peeked agent

**Files:**
- Modify: `packages/tui/src/screens/RoomScreen.tsx`

When peeking at an agent, gates (ask_user_question) from that agent should be visible and respondable. Currently gates are filtered out in `AgentConsoleView`.

- [ ] **Step 1: Pass gate handling into AgentConsoleView**

```tsx
function AgentConsoleView({
    client,
    sessionId,
    onGateAppeared,
}: {
    client: ElectricAgentClient
    sessionId: string
    onGateAppeared?: () => void
}) {
    const { entries, isLive, error } = useSessionStream(client, sessionId)
    const consoleEntries = entries.filter((e) => e.kind !== "gate")
    const hasUnresolvedGate = entries.some((e) => e.kind === "gate" && !e.resolved)
    // Use a ref to track notification — entries.find() creates new refs on every update
    const notifiedRef = useRef(false)

    useEffect(() => {
        if (hasUnresolvedGate && !notifiedRef.current && onGateAppeared) {
            notifiedRef.current = true
            onGateAppeared()
        }
        if (!hasUnresolvedGate) {
            notifiedRef.current = false
        }
    }, [hasUnresolvedGate, onGateAppeared])

    // ... rest of rendering
}
```

- [ ] **Step 2: Wire gate overlay in peek view**

In the RoomScreen render, when `view === "agent"`, add gate overlay support using the peeked agent's sessionId:

```tsx
view === "agent" && peekAgent ? (
    <Box flexDirection="column" flexGrow={1}>
        <AgentConsoleView
            client={client}
            sessionId={peekAgent.sessionId}
            onGateAppeared={() => setShowAgentGate(true)}
        />
        {/* Gate overlay for peeked agent would go here */}
    </Box>
)
```

Note: Full gate overlay support in peek view is a follow-up. For now, just show a `^G` hint when the peeked agent has an unresolved gate.

- [ ] **Step 3: Build and verify**

Run: `cd packages/tui && pnpm tsc --noEmit`
Expected: Clean compile

- [ ] **Step 4: Commit**

```bash
git add packages/tui/src/screens/RoomScreen.tsx
git commit -m "feat(tui): show gate indicator when peeking at agent"
```

---

## Phase 3: Protocol Client Parity

### Task 5: Add missing methods to protocol client

**Files:**
- Modify: `packages/protocol/src/client.ts`
- Modify: `packages/protocol/src/index.ts`

The WebUI's `api.ts` has methods not yet in the protocol client. Add them so WebUI can fully switch.

Methods to add:
- `fetchGhAccounts()` — list GitHub accounts/orgs
- `provisionElectric()` — provision Electric infra
- `getGitStatus(sessionId)` — git status for session
- `listGithubRepos()` — list repos
- `listBranches(repoFullName)` — list branches
- `resumeFromGithub(repoUrl, branch?)` — resume session from repo
- `addSessionToRoom(roomId, config)` — add existing session to room
- `iterateRoomSession(roomId, sessionId, request)` — iterate room session

- [ ] **Step 1: Add GitHub & provisioning methods**

In `client.ts`, add after the rooms section:

```typescript
// -----------------------------------------------------------------------
// GitHub & provisioning
// -----------------------------------------------------------------------

async fetchGhAccounts(): Promise<Array<{ login: string; type: string }>> {
    const creds = this.credentialFields()
    if (!creds.ghToken) return [] // Short-circuit — server returns [] without token anyway
    try {
        const headers: Record<string, string> = { "X-GH-Token": creds.ghToken }
        const res = await fetch(`${this.baseUrl}/github/accounts`, { headers })
        if (!res.ok) return []
        const data = await res.json() as { accounts?: Array<{ login: string; type: string }> }
        return data.accounts ?? []
    } catch {
        return []
    }
}

provisionElectric(): Promise<{
    sourceId: string
    secret: string
    databaseUrl: string
    electricUrl: string
    claimId: string
    claimUrl: string
}> {
    return this.request("/provision-electric", { method: "POST" })
}

getGitStatus(sessionId: string): Promise<{
    initialized: boolean
    branch: string | null
    remoteUrl: string | null
    hasUncommitted: boolean
    lastCommit: { hash: string; message: string; ts: string } | null
    repoName: string | null
}> {
    return this.request(`/sessions/${sessionId}/git-status`)
}

listGithubRepos(): Promise<{ repos: Array<{ nameWithOwner: string; url: string; updatedAt: string }> }> {
    const creds = this.credentialFields()
    const headers: Record<string, string> = {}
    if (creds.ghToken) headers["X-GH-Token"] = creds.ghToken
    return this.request("/github/repos", { headers })
}

listBranches(repoFullName: string): Promise<{ branches: Array<{ name: string; isDefault: boolean }> }> {
    const creds = this.credentialFields()
    const headers: Record<string, string> = {}
    if (creds.ghToken) headers["X-GH-Token"] = creds.ghToken
    return this.request(`/github/repos/${repoFullName}/branches`, { headers })
}

async resumeFromGithub(repoUrl: string, branch?: string): Promise<{
    sessionId: string
    session: SessionInfo
    sessionToken: string
}> {
    const result = await this.request<{
        sessionId: string
        session: SessionInfo
        sessionToken: string
    }>("/sessions/resume", {
        method: "POST",
        body: { repoUrl, branch, ...this.credentialFields() },
    })
    if (result.sessionToken) {
        this.tokens.setSessionToken(result.sessionId, result.sessionToken)
    }
    return result
}

addSessionToRoom(
    roomId: string,
    config: { sessionId: string; name: string; initialPrompt?: string },
): Promise<{ sessionId: string; participantName: string }> {
    const token = this.tokens.getSessionToken(config.sessionId)
    return this.request(`/rooms/${roomId}/sessions`, {
        method: "POST",
        body: config,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
}

iterateRoomSession(roomId: string, sessionId: string, userRequest: string): Promise<{ ok: boolean }> {
    return this.request(`/rooms/${roomId}/sessions/${sessionId}/iterate`, {
        method: "POST",
        body: { request: userRequest },
    })
}
```

- [ ] **Step 2: Export new types from protocol index.ts**

Ensure `SessionGitState` and any new types are exported from `packages/protocol/src/index.ts`.

- [ ] **Step 3: Build protocol package**

Run: `cd packages/protocol && pnpm tsc --noEmit`
Expected: Clean compile

- [ ] **Step 4: Commit**

```bash
git add packages/protocol/src/client.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): add missing methods for webui parity"
```

---

### Task 6: Refactor WebUI to use protocol client for REST calls

**Files:**
- Modify: `packages/studio/client/src/lib/api.ts`
- Modify: `packages/protocol/src/client.ts` (if needed for browser compatibility)

Replace the WebUI's `api.ts` REST methods with calls to `ElectricAgentClient`. Keep the file as a thin adapter that instantiates the client and re-exports methods.

- [ ] **Step 1: Create protocol client instance in WebUI**

At the top of `api.ts`, create a shared client instance:

```typescript
import { ElectricAgentClient, type TokenStore } from "@electric-agent/protocol/client"
import { getApiKey, getGhToken, getOauthToken } from "./credentials"
import { getOrCreateParticipant } from "./participant"
import { getRoomToken, getSessionToken, setRoomToken, setSessionToken } from "./session-store"

// Bridge localStorage tokens to protocol client's TokenStore interface
const browserTokenStore: TokenStore = {
    getSessionToken,
    setSessionToken,
    getRoomToken,
    setRoomToken,
}

let _devMode = false
export function setDevMode(mode: boolean) { _devMode = mode }

const client = new ElectricAgentClient({
    baseUrl: "/api",
    credentials: () => {
        const fields: { apiKey?: string; oauthToken?: string; ghToken?: string } = {}
        const apiKey = getApiKey()
        const oauthToken = getOauthToken()
        const ghToken = getGhToken()
        if (_devMode) {
            if (oauthToken) fields.oauthToken = oauthToken
            else if (apiKey) fields.apiKey = apiKey
        } else {
            if (apiKey) fields.apiKey = apiKey
        }
        if (ghToken) fields.ghToken = ghToken
        return fields
    },
    participant: () => getOrCreateParticipant(),
    tokenStore: browserTokenStore,
})

export { client }
```

- [ ] **Step 2: Replace REST method implementations with client delegation**

Replace each function body with a call to the client:

```typescript
export const fetchConfig = () => client.getConfig()
export const getSession = (id: string) => client.getSession(id)
export const createSession = (d: string, n?: string, f?: boolean) => client.createSession(d, n, f)
export const sendIterate = (id: string, req: string) => client.sendIterate(id, req)
export const respondToGate = (id: string, g: string, d: Record<string, unknown>) => client.respondToGate(id, g, d)
export const interruptSession = (id: string) => client.interruptSession(id)
export const cancelSession = (id: string) => client.cancelSession(id)
export const deleteSession = (id: string) => client.deleteSession(id)
export const startApp = (id: string) => client.startApp(id)
export const stopApp = (id: string) => client.stopApp(id)
export const createAppRoom = (d: string, n?: string) => client.createAppRoom(d, n)
export const createAgentRoom = (n: string, mr?: number) => client.createAgentRoom(n, mr)
export const joinAgentRoom = (id: string, c: string) => client.joinAgentRoom(id, c)
export const getAgentRoomState = (id: string) => client.getAgentRoomState(id)
export const addAgentToRoom = (id: string, c: Parameters<typeof client.addAgentToRoom>[1]) => client.addAgentToRoom(id, c)
export const sendRoomMessage = (rid: string, from: string, body: string, to?: string) => client.sendRoomMessage(rid, from, body, to)
export const closeAgentRoom = (id: string) => client.closeAgentRoom(id)
export const createLocalSession = (d?: string) => client.createLocalSession(d)
export const fetchKeychainCredentials = () => client.fetchKeychainCredentials()
export const fetchGhAccounts = () => client.fetchGhAccounts()
export const provisionElectric = () => client.provisionElectric()
export const getGitStatus = (id: string) => client.getGitStatus(id)
export const listGithubRepos = () => client.listGithubRepos()
export const listBranches = (repo: string) => client.listBranches(repo)
export const resumeFromGithub = (url: string, b?: string) => client.resumeFromGithub(url, b)
export const addSessionToRoom = (rid: string, c: Parameters<typeof client.addSessionToRoom>[1]) => client.addSessionToRoom(rid, c)
export const iterateRoomSession = (rid: string, sid: string, req: string) => client.iterateRoomSession(rid, sid, req)
```

Keep the existing type re-exports (`SessionInfo`, `RoomState`, etc.) pointing at `@electric-agent/protocol/client` types.

- [ ] **Step 3: Build and verify WebUI**

Run: `pnpm run build`
Expected: Clean compile, no type errors

- [ ] **Step 4: Manual test WebUI**

Start the server, open the web UI, create a room and verify:
- Session creation works
- Room creation works
- SSE events stream correctly (still using EventSource in useSession.ts)
- Gates work

- [ ] **Step 5: Commit**

```bash
git add packages/studio/client/src/lib/api.ts
git commit -m "refactor(studio): delegate REST calls to protocol client"
```

---

### Task 7: Migrate WebUI SSE from EventSource to protocol client

**Files:**
- Modify: `packages/studio/client/src/hooks/useSession.ts`
- Modify: `packages/studio/client/src/hooks/useRoomEvents.ts`
- Modify: `packages/studio/client/src/lib/api.ts` (export client)

Replace browser `EventSource` usage with the protocol client's `sessionEvents()` / `roomEvents()` async iterables. This unifies the SSE transport layer.

- [ ] **Step 1: Refactor useSession.ts to use protocol client**

Replace the EventSource-based SSE with the protocol client's async iterable:

```typescript
import { client } from "../lib/api"
import type { ConsoleEntry, EngineEvent } from "../lib/event-types"

export function useSession(sessionId: string | null) {
    const [entries, setEntries] = useState<ConsoleEntry[]>([])
    const [isLive, setIsLive] = useState(false)
    const [isComplete, setIsComplete] = useState(false)
    const [appStatus, setAppStatus] = useState<{...} | null>(null)

    const processEvent = useCallback((event: EngineEvent) => {
        // ... same processEvent logic (unchanged)
    }, [])

    useEffect(() => {
        if (!sessionId) return

        setEntries([])
        setIsLive(false)
        setIsComplete(false)
        setAppStatus(null)

        const abort = new AbortController()

        async function connect() {
            try {
                const stream = client.sessionEvents(sessionId!, { signal: abort.signal })
                setIsLive(true)
                for await (const event of stream) {
                    if (abort.signal.aborted) break
                    processEvent(event)
                }
            } catch (err) {
                if (!abort.signal.aborted) {
                    setIsLive(false)
                }
            }
        }

        connect()

        return () => { abort.abort() }
    }, [sessionId, processEvent])

    // ... same markGateResolved logic
    return { entries, isLive, isComplete, appStatus, markGateResolved }
}
```

This mirrors the TUI's `useSessionStream.ts` almost exactly, achieving SSE parity.

**NOTE:** The WebUI's `event-types.ts` gate union only includes `infra_config_prompt | ask_user_question`, while the TUI also handles `outbound_message_gate`. This should be aligned — add `outbound_message_gate` to the WebUI's `ConsoleEntry` gate type in `event-types.ts` and handle it in `processEvent`. This is a known gap tracked separately.

- [ ] **Step 2: Refactor useRoomEvents.ts similarly**

**NOTE:** The current WebUI hook also returns `messages` and `isLive`. Verify no callers depend on `messages` or `isLive` before dropping them. If callers exist, add them back:

```typescript
import { client } from "../lib/api"
import type { RoomEvent } from "./useRoomEvents" // keep existing type

export function useRoomEvents(roomId: string | null) {
    const [events, setEvents] = useState<RoomEvent[]>([])
    const [isClosed, setIsClosed] = useState(false)

    useEffect(() => {
        if (!roomId) return
        setEvents([])
        setIsClosed(false)

        const abort = new AbortController()

        async function connect() {
            try {
                const stream = client.roomEvents(roomId!, { signal: abort.signal })
                for await (const event of stream) {
                    if (abort.signal.aborted) break
                    setEvents((prev) => [...prev, event])
                    if (event.type === "room_closed") setIsClosed(true)
                }
            } catch {
                // Reconnection handled inside protocol client
            }
        }

        connect()
        return () => { abort.abort() }
    }, [roomId])

    return { events, isClosed }
}
```

- [ ] **Step 3: Remove dead imports from useSession.ts**

Remove `getSessionToken` import and the EventSource-related code.

- [ ] **Step 4: Build and verify**

Run: `pnpm run build`
Expected: Clean compile

- [ ] **Step 5: End-to-end test**

Start server + WebUI:
1. Create a room → verify events stream in
2. Create a standalone session → verify console works
3. Refresh page → verify reconnection resumes from last offset
4. Switch tabs → verify no duplicate events

- [ ] **Step 6: Commit**

```bash
git add packages/studio/client/src/hooks/useSession.ts packages/studio/client/src/hooks/useRoomEvents.ts
git commit -m "refactor(studio): unify SSE transport via protocol client"
```

---

## Phase 4: Verification & Integration Test

### Task 8: Side-by-side behavior comparison

**Files:** None (manual testing)

- [ ] **Step 1: Start server in dev mode**

```bash
SANDBOX_RUNTIME=docker pnpm run serve
```

- [ ] **Step 2: Open WebUI and TUI side by side**

```bash
# Terminal 1: WebUI
open http://localhost:4400

# Terminal 2: TUI
cd packages/tui && node dist/index.js --server http://localhost:4400
```

- [ ] **Step 3: Create room from WebUI**

1. Type a description, submit
2. Verify room page shows with participant bar
3. Verify room events stream (participant_joined, agent_message)
4. Peek at coder agent → verify console shows
5. Resolve infra gate

- [ ] **Step 4: Create room from TUI**

1. Type a description, submit (should create room by default)
2. Verify RoomScreen shows with participant bar
3. Verify room events stream
4. Press `^P` → select agent → verify console shows
5. Press `Esc` → back to room
6. Resolve infra gate via `^G`

- [ ] **Step 5: Compare server logs**

Check server logs for both flows. Verify:
- Same API endpoints called
- Same SSE connections established
- Same event filtering applied
- No auth errors for peek sessions

- [ ] **Step 6: Document any remaining discrepancies**

If differences remain, file them as follow-up tasks.

---

## Execution Order

Tasks 1-2 (TUI flow fix) and Task 5 (protocol methods) are independent — can be parallelized.

Tasks 3-4 (peek fix) depend on Task 1 (need rooms to test peek).

Tasks 6-7 (WebUI migration) depend on Task 5 (need methods in protocol client).

Task 8 (verification) depends on all prior tasks.

```
Task 1 ──→ Task 3 ──→ Task 4 ──┐
Task 2 ────────────────────────→├──→ Task 8
Task 5 ──→ Task 6 ──→ Task 7 ──┘
```
