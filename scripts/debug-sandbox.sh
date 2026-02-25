#!/usr/bin/env bash
# Debug script: build sandbox image, inspect filesystem, run scaffolding, check drizzle config
set -euo pipefail

IMAGE="electric-agent-sandbox"
CONTAINER="debug-sandbox-$$"

cleanup() {
	echo "--- Cleaning up container $CONTAINER ---"
	docker rm -f "$CONTAINER" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Step 1: Build sandbox image ==="
npm run build:sandbox

echo ""
echo "=== Step 2: Start container (idle) ==="
docker run -d --name "$CONTAINER" "$IMAGE" tail -f /dev/null

echo ""
echo "=== Step 3: Inspect template files in image ==="
echo "--- /opt/electric-agent/template/ contents ---"
docker exec "$CONTAINER" ls -la /opt/electric-agent/template/
echo ""
echo "--- Check drizzle.config.ts in template ---"
docker exec "$CONTAINER" cat /opt/electric-agent/template/drizzle.config.ts || echo "MISSING!"

echo ""
echo "=== Step 4: Check __dirname resolution ==="
docker exec "$CONTAINER" node -e "
const path = require('path');
const templateDir = path.resolve('/opt/electric-agent/dist/scaffold', '../../template');
console.log('Resolved templateDir:', templateDir);
const fs = require('fs');
console.log('Exists:', fs.existsSync(templateDir));
if (fs.existsSync(templateDir)) {
  console.log('Contents:', fs.readdirSync(templateDir));
}
"

echo ""
echo "=== Step 5: Run scaffolding (no install, no git) ==="
# We need postgres for drizzle-kit migrate, but we can at least test scaffold + generate
docker exec "$CONTAINER" node -e "
const { scaffold } = require('/opt/electric-agent/dist/scaffold/index.js');
scaffold('/home/agent/workspace/test-app', {
  skipInstall: true,
  skipGit: true,
  projectName: 'test-app',
  reporter: {
    log: (level, msg) => console.log('[' + level + ']', msg),
    verboseMode: true
  }
}).then(result => {
  console.log('Scaffold result:', JSON.stringify(result, null, 2));
}).catch(err => {
  console.error('Scaffold failed:', err.message);
});
" 2>&1 || echo "Scaffold step failed (may be ESM issue, trying alternative...)"

# If ESM import fails, try running via the CLI in a simpler way
echo ""
echo "--- Fallback: manual scaffold simulation ---"
docker exec "$CONTAINER" bash -c '
set -e
PROJECT=/home/agent/workspace/test-manual
mkdir -p "$PROJECT"

# Simulate what scaffold does: clone KPB + copy template overlay
echo "Cloning KPB template..."
npx gitpick KyleAMathews/kpb "$PROJECT" -o 2>&1 | tail -5

echo ""
echo "Copying template overlay..."
cp -rv /opt/electric-agent/template/* "$PROJECT/"

echo ""
echo "Project root after scaffold:"
ls -la "$PROJECT/"

echo ""
echo "--- drizzle.config.ts ---"
cat "$PROJECT/drizzle.config.ts" 2>/dev/null || echo "MISSING: drizzle.config.ts not found!"

echo ""
echo "--- src/db/ directory ---"
ls -la "$PROJECT/src/db/" 2>/dev/null || echo "No src/db/ yet (expected — coder creates it)"
'

echo ""
echo "=== Step 6: Install deps and test drizzle-kit ==="
docker exec "$CONTAINER" bash -c '
set -e
PROJECT=/home/agent/workspace/test-manual
cd "$PROJECT"

echo "Installing dependencies..."
pnpm install --ignore-workspace 2>&1 | tail -5

echo ""
echo "--- drizzle.config.ts still present after install? ---"
ls -la drizzle.config.ts 2>/dev/null || echo "MISSING after install!"
cat drizzle.config.ts 2>/dev/null || true

echo ""
echo "--- Testing drizzle-kit generate (expect failure: no schema yet) ---"
npx drizzle-kit generate 2>&1 || echo "(Expected to fail — no schema.ts yet)"

echo ""
echo "--- Create minimal schema to test full flow ---"
mkdir -p src/db
cat > src/db/schema.ts << '\''SCHEMA'\''
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"

export const todos = pgTable("todos", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
})
SCHEMA

echo ""
echo "--- drizzle-kit generate with schema ---"
npx drizzle-kit generate 2>&1

echo ""
echo "--- Generated migration files ---"
ls -la drizzle/ 2>/dev/null || echo "No drizzle/ directory created"
ls -la drizzle/meta/ 2>/dev/null || echo "No drizzle/meta/ directory"
'

echo ""
echo "=== Step 7: Final filesystem snapshot ==="
docker exec "$CONTAINER" bash -c '
PROJECT=/home/agent/workspace/test-manual
echo "--- All config files in project root ---"
ls -la "$PROJECT"/*.config.* "$PROJECT"/*.json 2>/dev/null || true
echo ""
echo "--- drizzle/ migration output ---"
find "$PROJECT/drizzle" -type f 2>/dev/null || echo "No migrations generated"
'

echo ""
echo "=== Done ==="
