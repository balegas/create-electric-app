import crypto from "node:crypto"
import { describe, expect, it, vi } from "vitest"

const { privateKey } = crypto.generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
})

describe("github-app", () => {
	describe("createGitHubAppJWT", () => {
		it("creates a valid JWT with correct claims", async () => {
			const { createGitHubAppJWT } = await import("./github-app.js")
			const jwt = createGitHubAppJWT("12345", privateKey)

			const parts = jwt.split(".")
			expect(parts).toHaveLength(3)

			const header = JSON.parse(Buffer.from(parts[0], "base64url").toString())
			expect(header).toEqual({ alg: "RS256", typ: "JWT" })

			const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString())
			expect(payload.iss).toBe("12345")
			expect(payload.exp).toBeGreaterThan(payload.iat)
			expect(payload.exp - payload.iat).toBe(660) // 600s expiry + 60s clock drift offset
		})
	})

	describe("getInstallationToken", () => {
		it("exchanges JWT for installation token", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						token: "ghs_test123",
						expires_at: "2026-03-12T12:00:00Z",
					}),
			})
			vi.stubGlobal("fetch", mockFetch)

			const { getInstallationToken } = await import("./github-app.js")
			const result = await getInstallationToken("12345", "67890", privateKey)

			expect(result.token).toBe("ghs_test123")
			expect(result.expires_at).toBe("2026-03-12T12:00:00Z")

			const [url, opts] = mockFetch.mock.calls[0]
			expect(url).toBe("https://api.github.com/app/installations/67890/access_tokens")
			expect(opts.method).toBe("POST")
			expect(opts.headers.Accept).toBe("application/vnd.github+json")
			expect(opts.headers.Authorization).toMatch(/^Bearer ey/)

			const body = JSON.parse(opts.body)
			expect(body.permissions).toEqual({
				contents: "write",
				administration: "write",
			})

			vi.unstubAllGlobals()
		})

		it("throws on GitHub API error", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
				text: () => Promise.resolve("Bad credentials"),
			})
			vi.stubGlobal("fetch", mockFetch)

			const { getInstallationToken } = await import("./github-app.js")
			await expect(getInstallationToken("12345", "67890", privateKey)).rejects.toThrow(
				"GitHub API error 401",
			)

			vi.unstubAllGlobals()
		})
	})
})
