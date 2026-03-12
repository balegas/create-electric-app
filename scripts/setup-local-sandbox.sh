#!/usr/bin/env bash
# ============================================================================
# setup-local-sandbox.sh
#
# Replicates the sandbox environment locally so you can run Claude Code
# sessions manually against a scaffolded project.
#
# Usage:
#   ./scripts/setup-local-sandbox.sh <project-name> [app-description]
#
# Prerequisites:
#   - Docker running (for Postgres + Electric)
#   - Node.js + pnpm installed
#   - Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`)
#   - ANTHROPIC_API_KEY set (or CLAUDE_CODE_OAUTH_TOKEN)
#
# What it does:
#   1. Starts Postgres + Electric via docker-compose
#   2. Scaffolds the project (clone KPB + overlay template + install deps)
#   3. Writes CLAUDE.md with local-mode instructions
#   4. Writes .claude/skills/ (create-app, room-messaging)
#   5. Prints the command to start Claude Code
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Args ───────────────────────────────────────────────────────────────────
PROJECT_NAME="${1:-my-test-app}"
DESCRIPTION="${2:-A simple todo app with categories and due dates}"
WORKSPACE_DIR="${SANDBOX_WORKSPACE:-$HOME/sandbox-workspace}"
PROJECT_DIR="$WORKSPACE_DIR/$PROJECT_NAME"

echo "=== Local Sandbox Setup ==="
echo "  Project:   $PROJECT_NAME"
echo "  Workspace: $WORKSPACE_DIR"
echo "  Project:   $PROJECT_DIR"
echo ""

# ── 1. Start Postgres + Electric ──────────────────────────────────────────
COMPOSE_DIR="$WORKSPACE_DIR/.infra"
mkdir -p "$COMPOSE_DIR"

cat > "$COMPOSE_DIR/docker-compose.yml" << 'COMPOSE_EOF'
services:
  postgres:
    image: postgres:17
    ports:
      - "54321:5432"
    environment:
      POSTGRES_DB: electric
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
    command: postgres -c wal_level=logical -c max_replication_slots=10 -c max_wal_senders=10
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 2s
      timeout: 5s
      retries: 10
    volumes:
      - pgdata:/var/lib/postgresql/data

  electric:
    image: electricsql/electric:latest
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://postgres:password@postgres:5432/electric
      ELECTRIC_INSECURE: "true"
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  pgdata:
COMPOSE_EOF

echo "Starting Postgres + Electric..."
docker compose -p "sandbox-$PROJECT_NAME" -f "$COMPOSE_DIR/docker-compose.yml" up -d

# Wait for Electric to be healthy
echo -n "Waiting for Electric..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/v1/health > /dev/null 2>&1; then
    echo " ready!"
    break
  fi
  echo -n "."
  sleep 2
  if [ "$i" -eq 30 ]; then
    echo " TIMEOUT (continuing anyway)"
  fi
done

# ── 2. Scaffold project ──────────────────────────────────────────────────

if [ -d "$PROJECT_DIR" ]; then
  echo ""
  echo "Project directory already exists: $PROJECT_DIR"
  read -p "Delete and re-scaffold? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -rf "$PROJECT_DIR"
  else
    echo "Skipping scaffold, keeping existing project."
    SKIP_SCAFFOLD=1
  fi
fi

if [ "${SKIP_SCAFFOLD:-0}" != "1" ]; then
  echo ""
  echo "Scaffolding project..."

  # Check if electric-agent CLI is available (from this repo)
  if command -v electric-agent &> /dev/null; then
    echo "Using electric-agent CLI for scaffolding..."
    electric-agent scaffold "$PROJECT_DIR" --name "$PROJECT_NAME" --skip-git
  else
    echo "electric-agent not in PATH, using Node.js scaffold directly..."

    # Build the agent package if needed
    if [ ! -f "$REPO_ROOT/packages/agent/dist/scaffold/index.js" ]; then
      echo "Building @electric-agent/agent package..."
      (cd "$REPO_ROOT" && pnpm run build --filter @electric-agent/agent)
    fi

    # Run scaffold via Node
    node -e "
      import('$REPO_ROOT/packages/agent/dist/scaffold/index.js').then(async (mod) => {
        const result = await mod.scaffold('$PROJECT_DIR', {
          projectName: '$PROJECT_NAME',
          skipGit: false,
          reporter: { log: (level, msg) => console.log('[scaffold:' + level + '] ' + msg) }
        });
        if (result.errors.length > 0) {
          console.error('Scaffold errors:', result.errors);
        }
        console.log('Scaffold complete:', result.projectDir);
      }).catch(e => { console.error(e); process.exit(1); });
    "
  fi
fi

# ── 3. Set environment variables ──────────────────────────────────────────

# Write .env file for the project
cat > "$PROJECT_DIR/.env" << ENV_EOF
DATABASE_URL=postgresql://postgres:password@localhost:54321/electric
ELECTRIC_URL=http://localhost:3000
VITE_PORT=5174
ENV_EOF

echo "Wrote .env with local Postgres + Electric URLs"

# ── 4. Write CLAUDE.md ────────────────────────────────────────────────────

cat > "$PROJECT_DIR/CLAUDE.md" << 'CLAUDEMD_EOF'
# Local Sandbox Project

## Project Context
This is a local-first, real-time application built with Electric SQL + TanStack DB + Drizzle ORM + TanStack Start. Electric syncs Postgres data to the client via shapes; TanStack DB provides reactive collections and optimistic mutations.

## Local Environment
You are running on a local machine with Docker for Postgres + Electric.

### What's Available
- Node.js, pnpm, git
- Docker running Postgres (port 54321) and Electric (port 3000)
- `DATABASE_URL` and `ELECTRIC_URL` are set in .env
- Full internet access

### Ports
- App dev server: port 5174 (VITE_PORT)
- Postgres: localhost:54321
- Electric: localhost:3000

## Current Task
CLAUDEMD_EOF

# Append the description
echo "$DESCRIPTION" >> "$PROJECT_DIR/CLAUDE.md"

cat >> "$PROJECT_DIR/CLAUDE.md" << 'CLAUDEMD_EOF2'

## App Generation Pipeline (CRITICAL)
When building a new app, you MUST use the /create-app skill. This skill is available at .claude/skills/create-app/SKILL.md and provides the structured pipeline for generating Electric SQL apps.

Invoke it with: /create-app <description>

Do NOT skip phases or code ad-hoc. Always follow the skill's structured pipeline.

## Scaffold Structure
The project is scaffolded from a known template. Key files you should know about:
- src/db/schema.ts — placeholder Drizzle schema (you will overwrite)
- src/db/zod-schemas.ts — placeholder Zod derivation (you will overwrite)
- src/db/index.ts — Drizzle client setup (do not modify)
- src/db/utils.ts — parseDates + generateTxId helpers (do not modify)
- src/lib/electric-proxy.ts — Electric shape proxy helper (do not modify)
- src/components/ClientOnly.tsx — SSR wrapper (do not modify, just import when needed)
- src/routes/__root.tsx — root layout with SSR (do not add ssr:false here)
- tests/helpers/schema-test-utils.ts — generateValidRow/generateRowWithout (do not modify)

## Guardrails (MUST FOLLOW)

### Protected Files — DO NOT MODIFY
docker-compose.yml, vite.config.ts, tsconfig.json, biome.json, pnpm-lock.yaml, postgres.conf, vitest.config.ts, Caddyfile, drizzle.config.ts, src/db/index.ts, src/db/utils.ts, src/lib/electric-proxy.ts, src/components/ClientOnly.tsx, tests/helpers/schema-test-utils.ts

### Import Rules
- Use "zod/v4" (NOT "zod") for all Zod imports — drizzle-zod 0.8.x rejects v3 schema overrides
- Use "lucide-react" for icons (NOT @radix-ui/react-icons)
- Use "@radix-ui/themes" for Radix components (NOT @radix-ui/react-*)
- Use "react-router" for routing (NOT react-router-dom)

### Dependency Rules
- NEVER remove existing dependencies from package.json
- Only add new dependencies

### SSR Rule
NEVER add ssr: false to __root.tsx — it renders the HTML shell and must always SSR.
Add ssr: false to each LEAF route that uses useLiveQuery or collections.

## Playbook Skills (Domain Knowledge)
This project includes playbook skills shipped with its npm dependencies. These contain correct API usage patterns, code examples, and common mistakes for Electric SQL, TanStack DB, and related libraries.

**Discover all available skills by running:**
```bash
npx @tanstack/intent list
```

Read relevant skills BEFORE writing code for each phase. The create-app skill tells you which skills to read at each phase.

**Important:** Playbook examples use `import { z } from "zod"` but this project requires `import { z } from "zod/v4"`.

## Infrastructure (Pre-configured — DO NOT MODIFY)
The database (Postgres) and Electric sync service are already provisioned and configured via environment variables:
- `DATABASE_URL` — Postgres connection string
- `ELECTRIC_URL` — Electric sync service URL

These are read by src/db/index.ts, drizzle.config.ts, and src/lib/electric-proxy.ts — do not modify these files.

## Dev Server & Migrations
- `pnpm dev` — start the Vite dev server (foreground, for interactive use)
- `pnpm dev:start` — start in background
- `pnpm dev:stop` / `pnpm dev:restart`

The app is exposed on port 5174 (VITE_PORT).

After modifying src/db/schema.ts, ALWAYS run migrations:
```bash
pnpm drizzle-kit generate && pnpm drizzle-kit migrate
```
CLAUDEMD_EOF2

echo "Wrote CLAUDE.md"

# ── 5. Copy skills ───────────────────────────────────────────────────────
TEMPLATE_DIR="$REPO_ROOT/packages/agent/template"

# create-app skill
SKILL_SRC="$TEMPLATE_DIR/.claude/skills/create-app/SKILL.md"
SKILL_DST="$PROJECT_DIR/.claude/skills/create-app"
if [ -f "$SKILL_SRC" ]; then
  mkdir -p "$SKILL_DST"
  cp "$SKILL_SRC" "$SKILL_DST/SKILL.md"
  echo "Copied create-app skill"
fi

# ui-design skill (if exists)
UI_SKILL_SRC="$TEMPLATE_DIR/.claude/skills/ui-design/SKILL.md"
UI_SKILL_DST="$PROJECT_DIR/.claude/skills/ui-design"
if [ -f "$UI_SKILL_SRC" ]; then
  mkdir -p "$UI_SKILL_DST"
  cp "$UI_SKILL_SRC" "$UI_SKILL_DST/SKILL.md"
  echo "Copied ui-design skill"
fi

# room-messaging skill (generated at runtime, write inline)
ROOM_SKILL_DST="$PROJECT_DIR/.claude/skills/room-messaging"
mkdir -p "$ROOM_SKILL_DST"
# Try to get it from the built package, or skip
ROOM_SKILL_BUILT="$REPO_ROOT/packages/studio/src/bridge/room-messaging-skill.ts"
if [ -f "$ROOM_SKILL_BUILT" ]; then
  echo "Room-messaging skill source found (will be available if built)"
fi

# ── 6. Summary ────────────────────────────────────────────────────────────

echo ""
echo "=============================================="
echo "  Local sandbox ready!"
echo "=============================================="
echo ""
echo "  Project dir:  $PROJECT_DIR"
echo "  Postgres:     postgresql://postgres:password@localhost:54321/electric"
echo "  Electric:     http://localhost:3000"
echo "  App (after start): http://localhost:5174"
echo ""
echo "── To run Claude Code manually: ──"
echo ""
echo "  cd $PROJECT_DIR"
echo ""
echo "  # Interactive mode (recommended for debugging):"
echo "  claude"
echo ""
echo "  # Or with a prompt (like the studio does):"
echo "  claude -p '/create-app $DESCRIPTION' \\"
echo "    --model claude-sonnet-4-6 \\"
echo "    --allowedTools 'Read,Write,Edit,Bash,Glob,Grep,WebSearch,TodoWrite,Skill'"
echo ""
echo "  # Or with stream-json output (like the studio bridge):"
echo "  claude -p '/create-app $DESCRIPTION' \\"
echo "    --output-format stream-json \\"
echo "    --verbose \\"
echo "    --model claude-sonnet-4-6 \\"
echo "    --allowedTools 'Read,Write,Edit,Bash,Glob,Grep,WebSearch,TodoWrite,Skill'"
echo ""
echo "── To tear down: ──"
echo ""
echo "  docker compose -p sandbox-$PROJECT_NAME -f $COMPOSE_DIR/docker-compose.yml down -v"
echo "  rm -rf $PROJECT_DIR"
echo ""
