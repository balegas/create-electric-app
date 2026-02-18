import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Extracts name, description, and triggers without a YAML library.
 */
function parseFrontmatter(content: string): {
	description?: string
	triggers?: string[]
} {
	const match = content.match(/^---\n([\s\S]*?)\n---/)
	if (!match) return {}

	const yaml = match[1]
	const result: { description?: string; triggers?: string[] } = {}

	// Extract description (handles both single-line and multi-line block scalar)
	const descMatch = yaml.match(
		/description:\s*\|?\s*\n([\s\S]*?)(?=\n\w|\n---|\ntriggers:|\nmetadata:)/s,
	)
	if (descMatch) {
		result.description = descMatch[1]
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.join(" ")
	} else {
		const inlineDesc = yaml.match(/description:\s*(.+)/)
		if (inlineDesc) {
			result.description = inlineDesc[1].trim()
		}
	}

	// Extract triggers (YAML list)
	const triggersMatch = yaml.match(/triggers:\s*\n((?:\s+-\s+.+\n?)*)/)
	if (triggersMatch) {
		result.triggers = triggersMatch[1]
			.split("\n")
			.map((line) => line.replace(/^\s*-\s*/, "").trim())
			.filter(Boolean)
	}

	return result
}

const PLAYBOOK_PACKAGES = [
	{ pkg: "@electric-sql/playbook", prefix: "electric" },
	{ pkg: "@tanstack/db-playbook", prefix: "tanstack-db" },
	{ pkg: "@durable-streams/playbook", prefix: "durable-streams" },
]

/**
 * Resolve the bundled playbook directory that ships with electric-agent.
 * Contains project-specific patterns not covered by external playbook packages.
 */
function getBundledPlaybookDir(): string {
	// Try compiled path first, then source path
	const compiled = path.resolve(__dirname, "../../playbooks")
	if (fs.existsSync(compiled)) return compiled
	const source = path.resolve(__dirname, "../playbooks")
	if (fs.existsSync(source)) return source
	return compiled // fallback
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Find a skill directory by name. Supports:
 * - Direct match: skills/<name>/SKILL.md
 * - Nested match: skills/<parent>/<name>/SKILL.md (e.g., tanstack-db/collections)
 * - Bundled skills: playbooks/<name>/SKILL.md (shipped with electric-agent)
 */
function findPlaybookSkillDir(skillName: string, projectDir: string): string | null {
	for (const { pkg } of PLAYBOOK_PACKAGES) {
		const skillsDir = path.join(projectDir, "node_modules", pkg, "skills")
		if (!fs.existsSync(skillsDir)) continue

		// Direct match
		const direct = path.join(skillsDir, skillName)
		if (fs.existsSync(path.join(direct, "SKILL.md"))) return direct

		// Nested one level: skills/<parent>/<name>
		for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				const nested = path.join(skillsDir, entry.name, skillName)
				if (fs.existsSync(path.join(nested, "SKILL.md"))) return nested
			}
		}
	}

	// Check bundled playbooks
	const bundledDir = getBundledPlaybookDir()
	const bundled = path.join(bundledDir, skillName)
	if (fs.existsSync(path.join(bundled, "SKILL.md"))) return bundled

	return null
}

/**
 * Required playbook skills that must be present for code generation to work.
 * Each entry is a skill name that must be findable via findPlaybookSkillDir.
 */
const REQUIRED_SKILLS = ["live-queries", "collections", "mutations", "schemas"]

/**
 * Validate that all required playbook skills are installed in the project.
 * Throws if any are missing so generation fails fast.
 */
export function validatePlaybooks(projectDir: string): void {
	const missing: string[] = []

	for (const skill of REQUIRED_SKILLS) {
		if (!findPlaybookSkillDir(skill, projectDir)) {
			missing.push(skill)
		}
	}

	if (missing.length > 0) {
		const installed = PLAYBOOK_PACKAGES.filter(({ pkg }) =>
			fs.existsSync(path.join(projectDir, "node_modules", pkg, "skills")),
		).map(({ pkg }) => pkg)

		const notInstalled = PLAYBOOK_PACKAGES.filter(
			({ pkg }) => !fs.existsSync(path.join(projectDir, "node_modules", pkg, "skills")),
		).map(({ pkg }) => pkg)

		const lines = [
			`Required playbook skills missing: ${missing.join(", ")}`,
			installed.length > 0 ? `Installed playbook packages: ${installed.join(", ")}` : "",
			notInstalled.length > 0 ? `Missing playbook packages: ${notInstalled.join(", ")}` : "",
			"Run 'pnpm install' in the project directory to install playbook packages.",
		].filter(Boolean)

		throw new Error(lines.join("\n"))
	}
}

export function createPlaybookTools(projectDir: string) {
	const readPlaybookTool = tool(
		"read_playbook",
		"Read a playbook skill file (SKILL.md) and optionally its reference files. Use list_playbooks first to see available skill names.",
		{
			name: z
				.string()
				.describe(
					"Name of the playbook skill to read (e.g., 'collections', 'mutations', 'electric-quickstart')",
				),
			include_references: z
				.boolean()
				.optional()
				.describe("Whether to include reference files from the references/ subdirectory"),
		},
		async (args) => {
			const skillDir = findPlaybookSkillDir(args.name, projectDir)

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

	const listPlaybooksTool = tool(
		"list_playbooks",
		"List all available playbook skills with descriptions and triggers. Router skills (no parent) contain routing tables — read them first to discover which sub-skill you need.",
		{},
		async () => {
			const skills: Array<{
				name: string
				pkg: string
				parent?: string
				hasReferences: boolean
				description?: string
				triggers?: string[]
			}> = []

			for (const { pkg } of PLAYBOOK_PACKAGES) {
				const skillsDir = path.join(projectDir, "node_modules", pkg, "skills")
				if (!fs.existsSync(skillsDir)) continue

				const scanDir = (dir: string, parent?: string) => {
					for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
						if (entry.isDirectory()) {
							const entryDir = path.join(dir, entry.name)
							const skillFile = path.join(entryDir, "SKILL.md")
							if (fs.existsSync(skillFile)) {
								const refsDir = path.join(entryDir, "references")
								const frontmatter = parseFrontmatter(fs.readFileSync(skillFile, "utf-8"))
								skills.push({
									name: entry.name,
									pkg,
									parent,
									hasReferences: fs.existsSync(refsDir),
									description: frontmatter.description,
									triggers: frontmatter.triggers,
								})
							}
							// Always recurse to find nested skills
							scanDir(entryDir, entry.name)
						}
					}
				}

				scanDir(skillsDir)
			}

			// Scan bundled playbooks (shipped with electric-agent)
			const bundledDir = getBundledPlaybookDir()
			if (fs.existsSync(bundledDir)) {
				for (const entry of fs.readdirSync(bundledDir, { withFileTypes: true })) {
					if (entry.isDirectory()) {
						const entryDir = path.join(bundledDir, entry.name)
						const skillFile = path.join(entryDir, "SKILL.md")
						if (fs.existsSync(skillFile)) {
							const refsDir = path.join(entryDir, "references")
							const frontmatter = parseFrontmatter(fs.readFileSync(skillFile, "utf-8"))
							skills.push({
								name: entry.name,
								pkg: "electric-agent (built-in)",
								hasReferences: fs.existsSync(refsDir),
								description: frontmatter.description,
								triggers: frontmatter.triggers,
							})
						}
					}
				}
			}

			const output = skills
				.map((s) => {
					const indent = s.parent ? "  " : ""
					const refs = s.hasReferences ? " [has references]" : ""
					const desc = s.description ? ` — ${s.description}` : ""
					const triggers =
						s.triggers && s.triggers.length > 0 ? ` (triggers: ${s.triggers.join(", ")})` : ""
					return `${indent}- ${s.name}${desc}${triggers}${refs}`
				})
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

	return { readPlaybookTool, listPlaybooksTool }
}
