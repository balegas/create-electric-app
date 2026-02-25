import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Configuration, DockerRegistryApi } from "@daytonaio/api-client"
import type { Daytona } from "@daytonaio/sdk"

// ---------------------------------------------------------------------------
// Daytona Transient Registry — push local images + create snapshots
// ---------------------------------------------------------------------------

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "electric-agent-sandbox"

function getPackageVersion(): string {
	try {
		const __filename = fileURLToPath(import.meta.url)
		const __dirname = dirname(__filename)
		const pkgPath = resolve(__dirname, "../../../package.json")
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
		return pkg.version || "0.1.0"
	} catch {
		return "0.1.0"
	}
}

export interface PushImageOpts {
	apiKey: string
	apiUrl?: string
	localImage?: string
}

export interface PushImageResult {
	remoteImage: string
	registryUrl: string
	project: string
}

/**
 * Push a local Docker image to Daytona's transient registry.
 *
 * 1. Gets temporary push credentials via `DockerRegistryApi.getTransientPushAccess()`
 * 2. Tags the local image with the remote registry path
 * 3. Logs in, pushes, and logs out
 */
export async function pushImageToDaytona(opts: PushImageOpts): Promise<PushImageResult> {
	const localImage = opts.localImage ?? SANDBOX_IMAGE
	const apiUrl = opts.apiUrl ?? "https://app.daytona.io/api"
	const version = getPackageVersion()

	// Get transient push access credentials
	// DockerRegistryApi uses Bearer auth (accessToken), not apiKey header
	const config = new Configuration({
		accessToken: opts.apiKey,
		basePath: apiUrl,
	})
	const registryApi = new DockerRegistryApi(config)
	const response = await registryApi.getTransientPushAccess()
	const access = response.data

	const remoteImage = `${access.registryUrl}/${access.project}/${localImage}:${version}`

	console.log(`[daytona-registry] Pushing ${localImage} → ${remoteImage}`)
	console.log(`[daytona-registry] Registry: ${access.registryUrl} (expires: ${access.expiresAt})`)

	try {
		// Tag the local image
		execSync(`docker tag ${localImage} ${remoteImage}`, { stdio: "pipe" })

		// Login to the transient registry
		execSync(`docker login ${access.registryUrl} -u ${access.username} --password-stdin`, {
			input: access.secret,
			stdio: ["pipe", "pipe", "pipe"],
		})

		// Push the image
		console.log("[daytona-registry] Pushing image (this may take a while)...")
		execSync(`docker push ${remoteImage}`, { stdio: "inherit", timeout: 600_000 })

		console.log("[daytona-registry] Push complete")
	} finally {
		try {
			execSync(`docker logout ${access.registryUrl}`, { stdio: "pipe" })
		} catch {
			// Ignore logout errors
		}
	}

	return {
		remoteImage,
		registryUrl: access.registryUrl,
		project: access.project,
	}
}

export interface EnsureSnapshotOpts {
	apiKey: string
	apiUrl?: string
	localImage?: string
	/** Callback for snapshot creation logs */
	onLogs?: (chunk: string) => void
}

/**
 * Ensure a Daytona snapshot exists for the sandbox image.
 *
 * - If a snapshot with the expected name already exists and is active, returns its name.
 * - Otherwise, pushes the local image to the transient registry and creates a snapshot.
 */
export async function ensureSnapshot(daytona: Daytona, opts: EnsureSnapshotOpts): Promise<string> {
	const localImage = opts.localImage ?? SANDBOX_IMAGE
	const snapshotName = localImage

	// Check if snapshot already exists
	try {
		const existing = await daytona.snapshot.get(snapshotName)
		if (existing.state === "active") {
			console.log(`[daytona-registry] Snapshot "${snapshotName}" already exists and is active`)
			return snapshotName
		}
		console.log(
			`[daytona-registry] Snapshot "${snapshotName}" exists but state=${existing.state}, deleting before recreate...`,
		)
		await daytona.snapshot.delete(existing)
		console.log(`[daytona-registry] Old snapshot deleted`)
	} catch {
		console.log(`[daytona-registry] Snapshot "${snapshotName}" not found, creating...`)
	}

	// Push the local image to Daytona's transient registry
	const { remoteImage } = await pushImageToDaytona({
		apiKey: opts.apiKey,
		apiUrl: opts.apiUrl,
		localImage,
	})

	// Create the snapshot from the pushed image
	console.log(`[daytona-registry] Creating snapshot "${snapshotName}" from ${remoteImage}...`)
	await daytona.snapshot.create(
		{
			name: snapshotName,
			image: remoteImage,
			entrypoint: ["/bin/sh", "-c", "sleep infinity"],
		},
		{
			onLogs: opts.onLogs ?? ((chunk: string) => process.stdout.write(chunk)),
			timeout: 600,
		},
	)

	console.log(`[daytona-registry] Snapshot "${snapshotName}" created successfully`)
	return snapshotName
}

/**
 * Check if a snapshot exists and is active (non-throwing).
 */
export async function getSnapshotStatus(
	daytona: Daytona,
	snapshotName?: string,
): Promise<{ exists: boolean; state?: string }> {
	const name = snapshotName ?? SANDBOX_IMAGE
	try {
		const snapshot = await daytona.snapshot.get(name)
		return { exists: true, state: snapshot.state }
	} catch {
		return { exists: false }
	}
}
