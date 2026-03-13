import crypto from "node:crypto"

export function createGitHubAppJWT(appId: string, privateKey: string): string {
	const now = Math.floor(Date.now() / 1000)
	const header = { alg: "RS256", typ: "JWT" }
	const payload = {
		iss: appId,
		iat: now - 60, // 60 seconds in the past for clock drift
		exp: now + 600, // 10 minutes
	}

	const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url")
	const unsigned = `${enc(header)}.${enc(payload)}`

	const sign = crypto.createSign("RSA-SHA256")
	sign.update(unsigned)
	const signature = sign.sign(privateKey, "base64url")

	return `${unsigned}.${signature}`
}

export async function getInstallationToken(
	appId: string,
	installationId: string,
	privateKey: string,
): Promise<{ token: string; expires_at: string }> {
	const jwt = createGitHubAppJWT(appId, privateKey)

	const response = await fetch(
		`https://api.github.com/app/installations/${installationId}/access_tokens`,
		{
			method: "POST",
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${jwt}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
			// Don't scope permissions — inherit all permissions granted to the installation
			body: JSON.stringify({}),
		},
	)

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`GitHub API error ${response.status}: ${text}`)
	}

	const data = (await response.json()) as {
		token: string
		expires_at: string
	}
	return { token: data.token, expires_at: data.expires_at }
}

/**
 * Create a public repo in an org using a GitHub App installation token.
 * Returns the repo's clone URL, or null if creation failed (e.g. name conflict).
 */
export async function createOrgRepo(
	org: string,
	repoName: string,
	token: string,
): Promise<{ cloneUrl: string; htmlUrl: string } | null> {
	const response = await fetch(`https://api.github.com/orgs/${org}/repos`, {
		method: "POST",
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
		},
		body: JSON.stringify({
			name: repoName,
			visibility: "public",
			auto_init: false,
		}),
	})

	if (!response.ok) {
		const text = await response.text()
		console.warn(
			`[github-app] Failed to create repo ${org}/${repoName} (${response.status}): ${text}`,
		)
		return null
	}

	const data = (await response.json()) as {
		clone_url: string
		html_url: string
	}
	return { cloneUrl: data.clone_url, htmlUrl: data.html_url }
}
