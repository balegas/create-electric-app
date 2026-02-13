import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { scaffold } from "../src/scaffold/index.js"

const TEST_DIR = path.join(os.tmpdir(), `electric-test-${Date.now()}`)

describe("scaffold", () => {
	after(() => {
		// Clean up test directory
		if (fs.existsSync(TEST_DIR)) {
			fs.rmSync(TEST_DIR, { recursive: true, force: true })
		}
	})

	it("clones KPB and overlays template files", async () => {
		const result = await scaffold(TEST_DIR, {
			skipInstall: true,
			projectName: "test-app",
		})

		assert.equal(result.projectDir, TEST_DIR)
		assert.equal(result.skippedInstall, true)
		assert.deepEqual(result.errors, [])

		// KPB files should exist
		assert.ok(fs.existsSync(path.join(TEST_DIR, "package.json")), "package.json exists")
		assert.ok(fs.existsSync(path.join(TEST_DIR, "tsconfig.json")), "tsconfig.json exists")
		assert.ok(fs.existsSync(path.join(TEST_DIR, "vite.config.ts")), "vite.config.ts exists")
		assert.ok(
			fs.existsSync(path.join(TEST_DIR, "src/routes/__root.tsx")),
			"__root.tsx exists",
		)
	})

	it("overlays Electric template files", () => {
		assert.ok(
			fs.existsSync(path.join(TEST_DIR, "docker-compose.yml")),
			"docker-compose.yml exists",
		)
		assert.ok(fs.existsSync(path.join(TEST_DIR, "Caddyfile")), "Caddyfile exists")
		assert.ok(
			fs.existsSync(path.join(TEST_DIR, "drizzle.config.ts")),
			"drizzle.config.ts exists",
		)
		assert.ok(
			fs.existsSync(path.join(TEST_DIR, "postgres.conf")),
			"postgres.conf exists",
		)
		assert.ok(
			fs.existsSync(path.join(TEST_DIR, ".env.example")),
			".env.example exists",
		)
		assert.ok(
			fs.existsSync(path.join(TEST_DIR, "src/db/schema.ts")),
			"db/schema.ts exists",
		)
		assert.ok(
			fs.existsSync(path.join(TEST_DIR, "src/db/zod-schemas.ts")),
			"db/zod-schemas.ts exists",
		)
		assert.ok(
			fs.existsSync(path.join(TEST_DIR, "src/db/index.ts")),
			"db/index.ts exists",
		)
		assert.ok(
			fs.existsSync(path.join(TEST_DIR, "src/db/utils.ts")),
			"db/utils.ts exists",
		)
		assert.ok(
			fs.existsSync(path.join(TEST_DIR, "src/lib/electric-proxy.ts")),
			"electric-proxy.ts exists",
		)
	})

	it("renames project in package.json", () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(TEST_DIR, "package.json"), "utf-8"))
		assert.equal(pkg.name, "test-app")
	})

	it("merges Electric dependencies into package.json", () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(TEST_DIR, "package.json"), "utf-8"))

		// Electric deps
		assert.ok(pkg.dependencies["@tanstack/db"], "@tanstack/db added")
		assert.ok(pkg.dependencies["@tanstack/react-db"], "@tanstack/react-db added")
		assert.ok(
			pkg.dependencies["@tanstack/electric-db-collection"],
			"electric-db-collection added",
		)
		assert.ok(pkg.dependencies["@electric-sql/client"], "@electric-sql/client added")
		assert.ok(pkg.dependencies["drizzle-orm"], "drizzle-orm added")
		assert.ok(pkg.dependencies.postgres, "postgres added")
		assert.ok(pkg.dependencies.zod, "zod added")

		// Dev deps
		assert.ok(pkg.devDependencies["drizzle-kit"], "drizzle-kit added")

		// Scripts
		assert.equal(pkg.scripts.generate, "drizzle-kit generate")
		assert.equal(pkg.scripts.migrate, "drizzle-kit migrate")

		// Original KPB deps should still be there
		assert.ok(pkg.dependencies.react, "react preserved")
		assert.ok(pkg.dependencies["@radix-ui/themes"], "radix preserved")
	})

	it("preserves original KPB dependencies", () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(TEST_DIR, "package.json"), "utf-8"))
		assert.ok(pkg.dependencies["@tanstack/react-router"], "react-router preserved")
		assert.ok(pkg.dependencies["@tanstack/react-start"], "react-start preserved")
	})

	it("removes stale pnpm-lock.yaml", () => {
		assert.ok(
			!fs.existsSync(path.join(TEST_DIR, "pnpm-lock.yaml")),
			"pnpm-lock.yaml removed",
		)
	})

	it("patches vite.config.ts port to 5174", () => {
		const viteConfig = fs.readFileSync(path.join(TEST_DIR, "vite.config.ts"), "utf-8")
		assert.ok(viteConfig.includes("5174"), "port changed to 5174")
		assert.ok(!viteConfig.includes("port: 5173"), "port 5173 removed")
	})

	it("copies .env.example to .env", () => {
		assert.ok(fs.existsSync(path.join(TEST_DIR, ".env")), ".env created")
		const envContent = fs.readFileSync(path.join(TEST_DIR, ".env"), "utf-8")
		assert.ok(envContent.includes("DATABASE_URL"), "DATABASE_URL in .env")
	})

	it("creates _agent/ working memory directory", () => {
		assert.ok(
			fs.existsSync(path.join(TEST_DIR, "_agent/errors.md")),
			"errors.md exists",
		)
		assert.ok(
			fs.existsSync(path.join(TEST_DIR, "_agent/session.md")),
			"session.md exists",
		)
	})

	it("patches root route with ssr: false", () => {
		const rootRoute = fs.readFileSync(
			path.join(TEST_DIR, "src/routes/__root.tsx"),
			"utf-8",
		)
		assert.ok(rootRoute.includes("ssr: false"), "ssr: false injected into root route")
	})

	it("patches .gitignore with Electric entries", () => {
		const gitignore = fs.readFileSync(path.join(TEST_DIR, ".gitignore"), "utf-8")
		assert.ok(gitignore.includes("_agent/"), "_agent/ in .gitignore")
		assert.ok(gitignore.includes("drizzle/meta/"), "drizzle/meta/ in .gitignore")
		assert.ok(gitignore.includes(".env"), ".env in .gitignore")
	})
})
