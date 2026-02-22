#!/usr/bin/env tsx
import { Daytona } from "@daytonaio/sdk"
import "dotenv/config"

async function main() {
	const daytona = new Daytona({
		apiKey: process.env.DAYTONA_API_KEY,
		apiUrl: process.env.DAYTONA_API_URL,
		target: process.env.DAYTONA_TARGET ?? "eu",
	})

	const result = await daytona.list()
	const sandboxes = result.items
	console.log(`Found ${sandboxes.length} sandboxes`)

	for (const sb of sandboxes) {
		console.log(`\nSandbox: ${sb.id} state=${sb.state}`)
		if (sb.state !== "started") continue

		try {
			const log = await sb.process.executeCommand("cat /tmp/agent.log 2>/dev/null | tail -50")
			console.log("--- /tmp/agent.log ---")
			console.log(log.result ?? "(empty)")

			const ps = await sb.process.executeCommand("ps aux | grep electric")
			console.log("--- processes ---")
			console.log(ps.result ?? "(none)")

			const env = await sb.process.executeCommand("env | grep -E 'DS_|SESSION_ID' | sort")
			console.log("--- stream env ---")
			console.log(env.result ?? "(none)")

			// Check if the agent wrote anything to stderr
			const stderr = await sb.process.executeCommand(
				"cat /tmp/agent-stderr.log 2>/dev/null || echo '(no stderr log)'",
			)
			console.log("--- agent stderr ---")
			console.log(stderr.result ?? "(empty)")

			// Check node_modules for durable-streams
			const deps = await sb.process.executeCommand(
				"ls /opt/electric-agent/node_modules/@durable-streams 2>/dev/null || echo 'NOT FOUND'",
			)
			console.log("--- @durable-streams ---")
			console.log(deps.result ?? "(empty)")

			// Try running the agent manually to see errors
			const test = await sb.process.executeCommand(
				"cd /opt/electric-agent && timeout 5 node -e \"import('@durable-streams/client').then(m => console.log('ESM OK', Object.keys(m))).catch(e => console.error('ESM FAIL', e.message))\" 2>&1 || echo 'FAILED'",
				undefined,
				undefined,
				10,
			)
			console.log("--- durable-streams ESM import test ---")
			console.log(test.result ?? "(empty)")

			// Check npm link setup
			const linkCheck = await sb.process.executeCommand(
				"readlink -f $(which electric-agent) && head -3 $(readlink -f $(which electric-agent))",
			)
			console.log("--- electric-agent binary ---")
			console.log(linkCheck.result ?? "(empty)")

			// Test DurableStream connectivity from inside sandbox
			const streamTest = await sb.process.executeCommand(
				`timeout 10 node -e "
const {DurableStream} = await import('@durable-streams/client');
const url = process.env.DS_URL + '/v1/stream/' + process.env.DS_SERVICE_ID + '/session/' + process.env.SESSION_ID;
console.log('Stream URL:', url);
const reader = new DurableStream({ url, headers: { Authorization: 'Bearer ' + process.env.DS_SECRET }, contentType: 'application/json' });
console.log('Calling stream()...');
try {
  const response = await reader.stream({ offset: '-1', live: true });
  console.log('stream() returned, subscribing...');
  const cancel = response.subscribeJson((batch) => {
    console.log('Got batch:', batch.items.length, 'items');
    for (const item of batch.items) {
      console.log('  item:', item.type, item.source);
    }
    cancel();
    process.exit(0);
  });
} catch (e) {
  console.error('stream() error:', e.message);
}
" 2>&1 || echo "TEST TIMED OUT OR FAILED"`,
				undefined,
				undefined,
				15,
			)
			console.log("--- DurableStream connectivity test ---")
			console.log(streamTest.result ?? "(empty)")
		} catch (e: unknown) {
			console.log("Error reading sandbox:", (e as Error).message)
		}
	}
}
main()
