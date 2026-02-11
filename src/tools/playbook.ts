import { tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import fs from "node:fs"
import path from "node:path"

const PLAYBOOK_PACKAGES = [
	{ pkg: "@electric-sql/playbook", prefix: "electric" },
	{ pkg: "@tanstack/db-playbook", prefix: "tanstack-db" },
	{ pkg: "@durable-streams/playbook", prefix: "durable-streams" },
]

function findPlaybookSkillDir(skillName: string, cwd?: string): string | null {
	const baseDir = cwd || process.cwd()

	for (const { pkg } of PLAYBOOK_PACKAGES) {
		const skillsDir = path.join(baseDir, "node_modules", pkg, "skills")
		if (!fs.existsSync(skillsDir)) continue

		// Check if skill directory exists directly
		const skillDir = path.join(skillsDir, skillName)
		if (fs.existsSync(skillDir)) return skillDir

		// Check subdirectories
		for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				const nested = path.join(skillsDir, entry.name, skillName)
				if (fs.existsSync(nested)) return nested
			}
		}
	}

	return null
}

export const readPlaybookTool = tool(
	"read_playbook",
	"Read a playbook skill file (SKILL.md) and optionally its reference files. Available playbooks: electric, electric-quickstart, electric-tanstack-integration, electric-security-check, electric-go-live, deploying-electric, tanstack-start-quickstart, tanstack-db, tanstack-db-collections, tanstack-db-electric, tanstack-db-live-queries, tanstack-db-mutations, tanstack-db-schemas, tanstack-db-query, durable-streams, durable-state, durable-streams-dev-setup",
	{
		name: z.string().describe("Name of the playbook skill to read"),
		include_references: z
			.boolean()
			.optional()
			.describe("Whether to include reference files from the references/ subdirectory"),
	},
	async (args) => {
		const skillDir = findPlaybookSkillDir(args.name)

		if (!skillDir) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Playbook skill "${args.name}" not found. Use list_playbooks to see available skills.`,
					},
				],
			}
		}

		const parts: string[] = []

		// Read SKILL.md
		const skillFile = path.join(skillDir, "SKILL.md")
		if (fs.existsSync(skillFile)) {
			parts.push(`# ${args.name}\n\n${fs.readFileSync(skillFile, "utf-8")}`)
		}

		// Read references if requested
		if (args.include_references) {
			const refsDir = path.join(skillDir, "references")
			if (fs.existsSync(refsDir)) {
				for (const entry of fs.readdirSync(refsDir, { withFileTypes: true })) {
					if (entry.isFile() && entry.name.endsWith(".md")) {
						const refContent = fs.readFileSync(path.join(refsDir, entry.name), "utf-8")
						parts.push(`\n## Reference: ${entry.name}\n\n${refContent}`)
					}
				}
			}
		}

		return {
			content: [
				{
					type: "text" as const,
					text: parts.join("\n\n---\n\n") || `No content found for skill "${args.name}"`,
				},
			],
		}
	},
)

export const listPlaybooksTool = tool(
	"list_playbooks",
	"List all available playbook skills across all installed playbook packages",
	{},
	async () => {
		const skills: Array<{ name: string; pkg: string; hasReferences: boolean }> = []

		for (const { pkg } of PLAYBOOK_PACKAGES) {
			const skillsDir = path.join(process.cwd(), "node_modules", pkg, "skills")
			if (!fs.existsSync(skillsDir)) continue

			const scanDir = (dir: string) => {
				for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
					if (entry.isDirectory()) {
						const skillFile = path.join(dir, entry.name, "SKILL.md")
						if (fs.existsSync(skillFile)) {
							const refsDir = path.join(dir, entry.name, "references")
							skills.push({
								name: entry.name,
								pkg,
								hasReferences: fs.existsSync(refsDir),
							})
						} else {
							// Check nested
							scanDir(path.join(dir, entry.name))
						}
					}
				}
			}

			scanDir(skillsDir)
		}

		const output = skills
			.map(
				(s) =>
					`- ${s.name} (from ${s.pkg})${s.hasReferences ? " [has references]" : ""}`,
			)
			.join("\n")

		return {
			content: [
				{
					type: "text" as const,
					text: output || "No playbook skills found. Ensure playbook packages are installed.",
				},
			],
		}
	},
)
