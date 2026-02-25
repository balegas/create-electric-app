import { describe, it, mock } from "node:test"
import assert from "node:assert/strict"

// ---------------------------------------------------------------------------
// Unit tests — mock fetch to test provisionElectricResources
// ---------------------------------------------------------------------------

describe("provisionElectricResources", () => {
	it("provisions resources via POST + poll", async () => {
		const claimId = "test-claim-id-123"
		const mockSourceId = "src_abc123"
		const mockSecret = "sec_xyz789"
		const mockDbUrl = "postgresql://user:pass@host:5432/db"

		// Track call count to simulate polling
		let pollCount = 0

		const originalFetch = globalThis.fetch
		globalThis.fetch = mock.fn(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString()

			// POST to create claimable source
			if (url.includes("/public/v1/claimable-sources") && !url.includes(claimId)) {
				return new Response(JSON.stringify({ claimId }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			}

			// GET to poll status
			if (url.includes(`/public/v1/claimable-sources/${claimId}`)) {
				pollCount++
				if (pollCount < 2) {
					// First poll: still pending
					return new Response(
						JSON.stringify({ state: "pending", source: null, connection_uri: null, error: null }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					)
				}
				// Second poll: ready
				return new Response(
					JSON.stringify({
						state: "ready",
						source: { source_id: mockSourceId, secret: mockSecret },
						connection_uri: mockDbUrl,
						error: null,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				)
			}

			return new Response("Not found", { status: 404 })
		}) as typeof fetch

		try {
			const { provisionElectricResources } = await import("../src/studio/electric-api.js")
			const result = await provisionElectricResources()

			assert.equal(result.source_id, mockSourceId)
			assert.equal(result.secret, mockSecret)
			assert.equal(result.DATABASE_URL, mockDbUrl)
			assert.equal(result.claimId, claimId)
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	it("throws on API error during POST", async () => {
		const originalFetch = globalThis.fetch
		globalThis.fetch = mock.fn(async () => {
			return new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" })
		}) as typeof fetch

		try {
			const { provisionElectricResources } = await import("../src/studio/electric-api.js")
			await assert.rejects(() => provisionElectricResources(), /Electric API error: 500/)
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	it("throws on provisioning failure", async () => {
		const claimId = "test-claim-fail"

		const originalFetch = globalThis.fetch
		globalThis.fetch = mock.fn(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString()

			if (url.includes("/public/v1/claimable-sources") && !url.includes(claimId)) {
				return new Response(JSON.stringify({ claimId }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			}

			if (url.includes(`/public/v1/claimable-sources/${claimId}`)) {
				return new Response(
					JSON.stringify({
						state: "failed",
						source: null,
						connection_uri: null,
						error: "Neon provisioning failed",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				)
			}

			return new Response("Not found", { status: 404 })
		}) as typeof fetch

		try {
			const { provisionElectricResources } = await import("../src/studio/electric-api.js")
			await assert.rejects(() => provisionElectricResources(), /Neon provisioning failed/)
		} finally {
			globalThis.fetch = originalFetch
		}
	})
})

// ---------------------------------------------------------------------------
// InfraConfig type tests — verify claim mode structure
// ---------------------------------------------------------------------------

describe("InfraConfig claim mode", () => {
	it("accepts claim mode with all required fields", () => {
		// This is a compile-time check — if InfraConfig doesn't support claim mode, tsc will fail
		const config: import("../src/sandbox/types.js").InfraConfig = {
			mode: "claim",
			databaseUrl: "postgresql://user:pass@host:5432/db",
			electricUrl: "https://api.electric-sql.cloud",
			sourceId: "src_123",
			secret: "sec_456",
			claimId: "claim_789",
		}
		assert.equal(config.mode, "claim")
	})
})

// ---------------------------------------------------------------------------
// Real integration test — hits the actual Claim API (disabled by default)
// ---------------------------------------------------------------------------

describe("Claim API integration (real)", { skip: !process.env.RUN_CLAIM_TESTS }, () => {
	it("provisions real resources via the Claim API", async () => {
		const { provisionElectricResources } = await import("../src/studio/electric-api.js")
		const result = await provisionElectricResources()

		assert.ok(result.source_id, "source_id should be present")
		assert.ok(result.secret, "secret should be present")
		assert.ok(result.DATABASE_URL, "DATABASE_URL should be present")
		assert.ok(result.claimId, "claimId should be present")
		assert.ok(
			result.DATABASE_URL.startsWith("postgresql://"),
			"DATABASE_URL should be a postgres connection string",
		)
	})
})
