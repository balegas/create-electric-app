import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Configuration, DockerRegistryApi } from "@daytonaio/api-client"
import type { Daytona } from "@daytonaio/sdk"

// ---------------------------------------------------------------------------
// Daytona Registry — push to Docker Hub + register in Daytona + snapshots
// ---------------------------------------------------------------------------

const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || "electric-agent-sandbox"
const DOCKER_HUB_URL = "https://index.docker.io"
const REGISTRY_NAME = "electric-agent-dockerhub"

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
	/** Daytona API key (for registering the registry in Daytona) */
	daytonaApiKey: string
	daytonaApiUrl?: string
	/** Docker Hub username */
	dockerHubUser: string
	/** Docker Hub personal access token */
	dockerHubToken: string
	localImage?: string
}

export interface PushImageResult {
	remoteImage: string
	dockerHubUser: string
}

/**
 * Ensure Docker Hub is registered in Daytona's registry API.
 * Idempotent — skips if already registered.
 */
async function ensureDockerHubRegistry(opts: {
	daytonaApiKey: string
	daytonaApiUrl?: string
	dockerHubUser: string
	dockerHubToken: string
}): Promise<void> {
	const apiUrl = opts.daytonaApiUrl ?? "https://app.daytona.io/api"
	const config = new Configuration({
		accessToken: opts.daytonaApiKey,
		basePath: apiUrl,
	})
	const registryApi = new DockerRegistryApi(config)

	// Check if we already registered this registry
	const existing = await registryApi.listRegistries()
	const found = existing.data.find(
		(r) =>
			r.name === REGISTRY_NAME || (r.url === DOCKER_HUB_URL && r.username === opts.dockerHubUser),
	)

	if (found) {
		console.log(`[daytona-registry] Docker Hub registry already registered (id: ${found.id})`)
		return
	}

	// Register Docker Hub in Daytona
	console.log("[daytona-registry] Registering Docker Hub in Daytona...")
	await registryApi.createRegistry({
		name: REGISTRY_NAME,
		url: DOCKER_HUB_URL,
		username: opts.dockerHubUser,
		password: opts.dockerHubToken,
		project: opts.dockerHubUser,
		registryType: "organization",
	})
	console.log("[daytona-registry] Docker Hub registered successfully")
}

/**
 * Push a local Docker image to Docker Hub and register the registry in Daytona.
 *
 * 1. Registers Docker Hub in Daytona's registry API (idempotent)
 * 2. Tags the local image for Docker Hub
 * 3. Logs in, pushes, and logs out
 */
export async function pushImageToDockerHub(opts: PushImageOpts): Promise<PushImageResult> {
	const localImage = opts.localImage ?? SANDBOX_IMAGE
	const version = getPackageVersion()
	const remoteImage = `${opts.dockerHubUser}/${localImage}:${version}`

	// Register Docker Hub in Daytona so it can pull the image
	await ensureDockerHubRegistry({
		daytonaApiKey: opts.daytonaApiKey,
		daytonaApiUrl: opts.daytonaApiUrl,
		dockerHubUser: opts.dockerHubUser,
		dockerHubToken: opts.dockerHubToken,
	})

	console.log(`[daytona-registry] Pushing ${localImage} → docker.io/${remoteImage}`)

	try {
		// Tag the local image
		execSync(`docker tag ${localImage} ${remoteImage}`, { stdio: "pipe" })

		// Login to Docker Hub
		execSync(`docker login -u ${opts.dockerHubUser} --password-stdin`, {
			input: opts.dockerHubToken,
			stdio: ["pipe", "pipe", "pipe"],
		})

		// Push the image
		console.log("[daytona-registry] Pushing image to Docker Hub...")
		execSync(`docker push ${remoteImage}`, { stdio: "inherit", timeout: 600_000 })

		console.log("[daytona-registry] Push complete")
	} finally {
		try {
			execSync("docker logout", { stdio: "pipe" })
		} catch {
			// Ignore logout errors
		}
	}

	return { remoteImage, dockerHubUser: opts.dockerHubUser }
}

export interface EnsureSnapshotOpts {
	daytonaApiKey: string
	daytonaApiUrl?: string
	dockerHubUser: string
	dockerHubToken: string
	localImage?: string
	/** Callback for snapshot creation logs */
	onLogs?: (chunk: string) => void
}

/**
 * Ensure a Daytona snapshot exists for the sandbox image.
 *
 * - If a snapshot with the expected name already exists and is active, returns its name.
 * - Otherwise, pushes the image to Docker Hub, registers the registry in Daytona,
 *   and creates a snapshot from the Docker Hub image.
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
			`[daytona-registry] Snapshot "${snapshotName}" exists but state=${existing.state}, recreating...`,
		)
	} catch {
		console.log(`[daytona-registry] Snapshot "${snapshotName}" not found, creating...`)
	}

	// Push to Docker Hub + register in Daytona
	const { remoteImage } = await pushImageToDockerHub({
		daytonaApiKey: opts.daytonaApiKey,
		daytonaApiUrl: opts.daytonaApiUrl,
		dockerHubUser: opts.dockerHubUser,
		dockerHubToken: opts.dockerHubToken,
		localImage,
	})

	// Create the snapshot from the Docker Hub image
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
