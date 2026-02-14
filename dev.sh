#!/usr/bin/env bash
set -e

# Dev environment for electric-agent web UI
# Starts three processes: tsc watch, backend server, and Vite dev server

cleanup() {
	echo ""
	echo "Shutting down dev environment..."
	kill $TSC_PID $SERVER_PID $VITE_PID 2>/dev/null || true
	wait $TSC_PID $SERVER_PID $VITE_PID 2>/dev/null || true
	echo "Done."
}
trap cleanup EXIT INT TERM

# 1. Initial build (so dist/ exists for the backend server)
echo "==> Building server..."
npx tsc

echo "==> Building web client..."
npx vite build --config src/web/client/vite.config.ts

# 2. Start tsc in watch mode (recompiles server on change)
echo "==> Starting tsc --watch..."
npx tsc --watch --preserveWatchOutput &
TSC_PID=$!

# 3. Give tsc a moment to start, then launch the backend server
sleep 1
echo "==> Starting backend server (port 4400)..."
node dist/index.js serve &
SERVER_PID=$!

# 4. Start Vite dev server for the React client (port 4401, proxies /api to 4400)
echo "==> Starting Vite dev server (port 4401)..."
npx vite --config src/web/client/vite.config.ts &
VITE_PID=$!

echo ""
echo "Dev environment ready:"
echo "  Web UI (HMR):  http://127.0.0.1:4401"
echo "  Backend API:   http://127.0.0.1:4400"
echo ""
echo "Press Ctrl+C to stop all processes."

# Wait for any process to exit
wait
