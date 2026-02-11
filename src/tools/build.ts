import { execSync } from "node:child_process"
import { tool } from "@anthropic-ai/claude-agent-sdk"

export function createBuildTool(projectDir: string) {
	return tool(
		"build",
		"Run pnpm build and pnpm check (Biome lint) in the project. Returns build output including any TypeScript or lint errors.",
		{},
		async () => {
			let buildOutput = ""
			let checkOutput = ""
			let success = true
			const errors: string[] = []

			try {
				buildOutput = execSync("pnpm run build 2>&1", {
					encoding: "utf-8",
					timeout: 120_000,
					cwd: projectDir,
				})
			} catch (e: unknown) {
				success = false
				buildOutput =
					(e as Record<string, string>)?.stdout || (e instanceof Error ? e.message : "Build failed")
				errors.push("build")
			}

			try {
				checkOutput = execSync("pnpm run check 2>&1", {
					encoding: "utf-8",
					timeout: 60_000,
					cwd: projectDir,
				})
			} catch (e: unknown) {
				success = false
				checkOutput =
					(e as Record<string, string>)?.stdout || (e instanceof Error ? e.message : "Check failed")
				errors.push("check")
			}

			const output = [
				"=== pnpm run build ===",
				buildOutput.trim(),
				"",
				"=== pnpm run check ===",
				checkOutput.trim(),
			].join("\n")

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							success,
							output: output.slice(0, 10_000),
							errors: errors.join(", ") || "none",
						}),
					},
				],
			}
		},
	)
}
