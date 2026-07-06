import { Glob, JSON5 } from "bun"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Rules } from "./rules"

export const DEFAULT_CLUTTER_RULES: ClutterRule[] = [
	{
		type: "backup",
		description: "Temporary editor state files should never be shipped in ModPortal zips.",
		category: "dev",
		severity: "medium",
		globs: ["*~", "*.bak", "*.orig", "*.rej", "*.swp", "*.swo"],
	},
	{
		type: "temp",
		description: "Scratch files and temporary directories do not belong in published mods.",
		category: "dev",
		severity: "medium",
		globs: ["*.tmp", "*.temp", "tmp/**", "temp/**", ".tmp/**", ".temp/**"],
	},
	{
		type: "logs",
		description: "Logs are generated locally and should not be published.",
		category: "dev",
		severity: "low",
		globs: ["*.log", "*.out", "*.err", "*.trace"],
	},
	{
		type: "compressed",
		description: "Archives are often release leftovers or accidental nested packages.",
		category: "build",
		severity: "high",
		globs: ["*.rar", "*.7z", "*.tar", "*.gz", "*.bz2", "*.xz", "*.tgz", "*.tbz2"],
	},
	{
		type: "executable",
		description: "Published mods should not include local binaries or installation scripts.",
		category: "dev",
		severity: "high",
		globs: ["*.exe", "*.dll", "*.so", "*.bin", "*.sh", "*.bat", "*.cmd", "*.ps1", "*.msi", "*.apk"],
	},
	{
		type: "image",
		description: "The mod should ship exported PNGs, not alternate raster formats.",
		category: "assets",
		severity: "high",
		globs: ["*.jpg", "*.jpeg", "*.gif", "*.bmp", "*.tiff", "*.webp", "*.ico", "*.tga", "*.dds"],
	},
	{
		type: "video",
		description: "Videos are not needed in published mod bundles.",
		category: "assets",
		severity: "high",
		globs: ["*.mp4", "*.avi", "*.mkv", "*.mov", "*.wmv"],
	},
	{
		type: "audio",
		description: "Source audio formats should stay out of release bundles unless exported to .ogg.",
		category: "assets",
		severity: "high",
		globs: ["*.mp3", "*.wav", "*.flac", "*.aac"],
	},
	{
		type: "documents",
		description: "Office documents and PDFs are not part of mod releases.",
		category: "assets",
		severity: "medium",
		globs: ["*.pdf", "*.doc", "*.docx", "*.odt", "*.rtf"],
	},
	{
		type: "fonts",
		description: "Font files should only ship when the mod requires custom fonts.",
		category: "assets",
		severity: "low",
		globs: ["*.ttf", "*.otf", "*.woff", "*.woff2"],
	},
	{
		type: "vcs",
		description: "Repository metadata is not part of the release payload.",
		category: "dev",
		severity: "high",
		globs: [".git", ".github", ".gitignore", ".gitattributes", ".gitmodules", ".svn", ".hg", ".bzr"],
	},
	{
		type: "ide",
		description: "Editor state and workspace config should stay out of published mods.",
		category: "dev",
		severity: "medium",
		globs: [".vscode", ".idea", "*.sublime-project", "*.sublime-workspace", ".vs", "*.code-workspace", "*.iml"],
	},
	{
		type: "osMetadata",
		description: "OS folder metadata and thumbnail caches should not be published.",
		category: "dev",
		severity: "high",
		globs: [".DS_Store", "Thumbs.db", "Desktop.ini"],
	},
	{
		type: "nodeArtifacts",
		description: "Tooling dependencies and build artifacts are not release assets.",
		category: "dev",
		severity: "medium",
		globs: [
			"node_modules",
			"package-lock.json",
			"yarn.lock",
			"pnpm-lock.yaml",
			"package.json",
			"*.tsbuildinfo",
			".npm",
			".yarn",
			".pnpm",
			".eslintcache",
			".turbo",
		],
	},
	{
		type: "testReports",
		description: "Test output and coverage are useful locally but should not ship.",
		category: "dev",
		severity: "low",
		globs: [
			"coverage",
			"test-results",
			"reports",
			"*.spec.*",
			"*.test.*",
			"junit.xml",
			"coverage.xml",
			"lcov.info",
		],
	},
	{
		type: "imageSources",
		description: "Image project sources are not release assets; export PNGs instead.",
		category: "assets",
		severity: "high",
		globs: ["*.xcf", "*.kra", "*.psd", "*.ora", "*.ai", "*.svg", "*.psb", "*.xcf.bak", "*.kra~", "*.ora~"],
	},
	{
		type: "compiled",
		description: "Generated binaries and caches should not be included in release archives.",
		category: "build",
		severity: "medium",
		globs: [
			"__pycache__",
			"*.pyc",
			"*.class",
			"*.jar",
			"*.luac",
			"*.o",
			"*.obj",
			"*.dylib",
			"*.pdb",
			"*.cache",
			"*.map",
			"*.wasm",
			"*.ipynb",
			".gradle",
		],
	},
	{
		type: "code",
		description: "Source and data files that should not ship in a Factorio release bundle.",
		category: "dev",
		severity: "medium",
		globs: [
			"*.java",
			"*.css",
			"*.scss",
			"*.sass",
			"*.less",
			"*.csv",
			"*.js",
			"*.jsx",
			"*.mjs",
			"*.cjs",
			"*.ts",
			"*.tsx",
			"*.mts",
			"*.cts",
			"*.html",
			"*.py",
			"*.rb",
			"*.go",
			"*.rs",
			"*.swift",
			"*.php",
			"*.pl",
			"*.kt",
			"*.gradle",
		],
	},
	{
		type: "secrets",
		description: "Secrets and private keys must never be published.",
		category: "secrets",
		severity: "high",
		globs: [".env", "*.env", "*.env.local", "*.pem", "*.key", "*.crt", "*.p12", "*.pfx", "id_rsa*", "secrets.*"],
	},
	{
		type: "dotFiles",
		description: "Hidden dotfiles should be treated as clutter unless explicitly allowed.",
		severity: "low",
		globs: [".*"],
	},
]

const ClutterRule = z.object({
	type: z.string(),
	description: z.string(),
	globs: z.array(z.string()),
	category: z.string().optional(),
	severity: z.enum(["low", "medium", "high"]).optional(),
	exceptions: z.array(z.string()).optional(),
})
type ClutterRule = z.infer<typeof ClutterRule>

export type CompiledClutterRule = {
	type: string
	description: string
	category?: string
	severity: "low" | "medium" | "high"
	matchers: Glob[]
	matcherExceptions: Glob[]
}

function compileClutterRule(rule: ClutterRule): CompiledClutterRule {
	const matchers = rule.globs.map((pattern) => new Glob(pattern))
	const matcherExceptions = rule.exceptions?.map((pattern) => new Glob(pattern)) ?? []
	return {
		type: rule.type,
		description: rule.description,
		category: rule.category,
		severity: rule.severity ?? "low",
		matchers,
		matcherExceptions,
	} satisfies CompiledClutterRule
}

export async function loadClutterRules(): Promise<CompiledClutterRule[]> {
	const cfgPath = process.env.CLUTTER_RULES_PATH || path.join(process.cwd(), "data/clutter-rules.json5")
	const loaded: ClutterRule[] = await readFile(cfgPath, "utf-8")
		.catch(() => null)
		.then(async (content) => {
			if (content) {
				try {
					const parsed = JSON5.parse(content)
					const validated = z.array(ClutterRule).safeParse(parsed)
					if (validated.success) {
						return validated.data
					} else {
						console.error(`Invalid clutter rules format in ${cfgPath}:`, z.treeifyError(validated.error))
					}
				} catch (err) {
					console.error(`Failed to parse clutter rules from ${cfgPath}:`, err)
				}
				process.exit(1)
			}
			// save default rules to disk for user reference and editing
			await mkdir(path.dirname(cfgPath), { recursive: true }).catch(console.error)
			await writeFile(cfgPath, JSON5.stringify(DEFAULT_CLUTTER_RULES, null, 2) ?? "").catch(console.error)
			return DEFAULT_CLUTTER_RULES
		})

	return loaded.map(compileClutterRule)
}
