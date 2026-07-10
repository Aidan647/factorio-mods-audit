import { Glob, JSON5 } from "bun"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

const DEFAULT_IMAGE_RULES: ImageRule[] = [
	{
		type: "thumbnail",
		description: "Thumbnail should be small and match expected dimensions.",
		category: "meta",
		severity: "low",
		globs: ["thumbnail.png"],
		optimal: 144,
		max: 288,
		maxMipmaps: 0,
	},
	{
		type: "icons",
		description: "Icons should be compact.",
		category: "icons",
		severity: "medium",
		globs: ["graphics/icons/**.png"],
		optimal: 64,
		max: 64,
		maxMipmaps: 3,
	},
	{
		type: "item-group",
		description: "Item group icons.",
		category: "icons",
		severity: "medium",
		globs: ["graphics/item-group/**.png"],
		optimal: 128,
		max: 128,
		maxMipmaps: 3,
	},
	{
		type: "technology",
		description: "Technology icons.",
		category: "icons",
		severity: "medium",
		globs: ["graphics/technology/**.png"],
		optimal: 256,
		max: 512,
		maxMipmaps: 3,
	},
	{
		type: "achievement",
		description: "Achievement icons.",
		category: "icons",
		severity: "medium",
		globs: ["graphics/achievement/**.png"],
		optimal: 128,
		max: 256,
		maxMipmaps: 3,
	},
	{
		type: "imageOptimization",
		description: "Images should be optimized",
		category: "rest",
		severity: "low",
		globs: ["**.png"],
	},
]
type SizeInput = number | { width: number; height: number }

const ImageRule = z.object({
	type: z.string(),
	description: z.string(),
	category: z.string(),
	severity: z.enum(["low", "medium", "high"]).optional(),
	globs: z.array(z.string()),
	optimal: z.union([z.number(), z.object({ width: z.number(), height: z.number() })]).optional(),
	max: z.union([z.number(), z.object({ width: z.number(), height: z.number() })]).optional(),
	maxMipmaps: z.number().optional(),
})
type ImageRule = z.infer<typeof ImageRule>

export type CompiledImageRule = {
	type: string
	description: string
	category: string
	severity: "low" | "medium" | "high"
	globs: string[]
	matchers: Glob[]
	optimalSize: { width: number; height: number } | null
	maxSize: { width: number; height: number } | null
	maxMipmaps: number
}

function resolveSize(size: SizeInput | undefined): { width: number; height: number } | null {
	if (size === undefined) return null
	return typeof size === "number" ? { width: size, height: size } : size
}

function compileImageRule(rule: ImageRule): CompiledImageRule {
	const matchers = rule.globs.map((pattern) => new Glob(pattern))
	return {
		type: rule.type,
		description: rule.description,
		category: rule.category,
		severity: rule.severity ?? "low",
		globs: rule.globs,
		matchers,
		optimalSize: resolveSize(rule.optimal),
		maxSize: resolveSize(rule.max),
		maxMipmaps: rule.maxMipmaps ?? 0,
	} satisfies CompiledImageRule
}

export async function loadImageRules(): Promise<CompiledImageRule[]> {
	const cfgPath = process.env.IMAGE_RULES_PATH || path.join(process.cwd(), "data/image-rules.json5")
	const loaded: ImageRule[] = await readFile(cfgPath, "utf-8")
		.catch(() => null)
		.then(async (content) => {
			if (content) {
				try {
					const parsed = JSON5.parse(content)
					const validated = z.array(ImageRule).safeParse(parsed)
					if (validated.success) {
						return validated.data
					} else {
						console.error(`Invalid image rules format in ${cfgPath}:`, z.treeifyError(validated.error))
					}
				} catch (err) {
					console.error(`Failed to parse image rules from ${cfgPath}:`, err)
				}
				process.exit(1)
			}
			await mkdir(path.dirname(cfgPath), { recursive: true }).catch(console.error)
			await writeFile(cfgPath, JSON5.stringify(DEFAULT_IMAGE_RULES, null, 2) ?? "").catch(console.error)
			return DEFAULT_IMAGE_RULES
		})

	return loaded.map(compileImageRule)
}
