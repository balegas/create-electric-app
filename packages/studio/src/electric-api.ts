// Claim API client — provisions temporary Electric Cloud resources via the
// Electric dashboard's public claimable-sources endpoint.

export interface ElectricCredentials {
	source_id: string
	secret: string
	DATABASE_URL: string
}

export interface ClaimableSourceResponse {
	claimId: string
}

interface ClaimableSourceStatus {
	state: "pending" | "ready" | "failed"
	source: {
		source_id: string
		secret: string
	}
	connection_uri: string
	claim_link?: string
	project_id?: string
	error: string | null
}

export const DEFAULT_ELECTRIC_API_BASE = "https://dashboard.electric-sql.cloud/api"
export const DEFAULT_ELECTRIC_URL = "https://api.electric-sql.cloud"
export const DEFAULT_ELECTRIC_DASHBOARD_URL = "https://dashboard.electric-sql.cloud"

export function getClaimUrl(claimId: string): string {
	const dashboardUrl = process.env.ELECTRIC_DASHBOARD_URL ?? DEFAULT_ELECTRIC_DASHBOARD_URL
	return `${dashboardUrl}/claim?uuid=${claimId}`
}

function getElectricApiBase(): string {
	return process.env.ELECTRIC_API_BASE_URL ?? DEFAULT_ELECTRIC_API_BASE
}

const POLL_INTERVAL_MS = 1000
const MAX_POLL_ATTEMPTS = 60

async function pollClaimableSource(
	claimId: string,
	maxAttempts: number = MAX_POLL_ATTEMPTS,
): Promise<ClaimableSourceStatus> {
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const response = await fetch(`${getElectricApiBase()}/public/v1/claimable-sources/${claimId}`, {
			method: "GET",
			headers: { "User-Agent": "create-electric-app" },
		})

		// 404 means still being provisioned — continue polling
		if (response.status === 404) {
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
			continue
		}

		if (!response.ok) {
			throw new Error(`Electric API error: ${response.status} ${response.statusText}`)
		}

		const status = (await response.json()) as ClaimableSourceStatus

		if (status.state === "ready") {
			return status
		}

		if (status.state === "failed" || status.error) {
			throw new Error(`Resource provisioning failed${status.error ? `: ${status.error}` : ""}`)
		}

		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
	}

	throw new Error(`Timeout waiting for resources to be provisioned after ${maxAttempts} attempts`)
}

export async function provisionElectricResources(): Promise<
	ElectricCredentials & ClaimableSourceResponse
> {
	console.log("[electric-api] Provisioning claimable resources...")

	const response = await fetch(`${getElectricApiBase()}/public/v1/claimable-sources`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": "create-electric-app",
		},
		body: JSON.stringify({}),
	})

	if (!response.ok) {
		throw new Error(`Electric API error: ${response.status} ${response.statusText}`)
	}

	const { claimId } = (await response.json()) as ClaimableSourceResponse

	if (!claimId) {
		throw new Error("Invalid response from Electric API — missing claimId")
	}

	console.log(`[electric-api] Got claimId=${claimId}, polling for ready state...`)
	const status = await pollClaimableSource(claimId)

	if (!status.source?.source_id || !status.source?.secret || !status.connection_uri) {
		throw new Error("Invalid response from Electric API — missing required credentials")
	}

	console.log("[electric-api] Resources provisioned successfully")

	return {
		source_id: status.source.source_id,
		secret: status.source.secret,
		DATABASE_URL: status.connection_uri,
		claimId,
	}
}
