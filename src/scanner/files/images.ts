import { Glob, JSON5 } from "bun"
import { z } from "zod"
import path from "node:path"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import type { Scanner, ScannerResult } from "../base"
import type { Finding, ReportBuilder } from "#/report"
import { checkImage, loadImage, type ImageFinding } from "./helpers/image-checks"
import type { FileEntry, PathEntry } from "../walkDir"
import { DEFAULT_IMAGE_RULES } from "./helpers/default-image-rules"

type SizeInput = number | { width: number; height: number }

type ImageRule = {
	type: string
	description: string
	category: string
	severity: "low" | "medium" | "high"
	globs: string[]
	optimal?: SizeInput
	max?: SizeInput
	maxMipmaps?: number
}

export type CompiledImageRule = ImageRule & {
	matchers: Glob[]
	optimalSize: { width: number; height: number } | null
	maxSize: { width: number; height: number } | null
	maxMipmaps: number
}

function resolveSize(size: SizeInput | undefined): { width: number; height: number } | null {
	if (size === undefined) return null
	return typeof size === "number" ? { width: size, height: size } : size
}

let cachedRules: CompiledImageRule[] | null = null

async function loadImageRules(): Promise<CompiledImageRule[]> {
	if (cachedRules) return cachedRules

	const cfgPath = process.env.IMAGE_RULES_PATH || path.join(process.cwd(), "data/image-rules.json5")
	const { raw, missing } = await readFile(cfgPath, "utf-8")
		.then((content) => ({ raw: content, missing: false }))
		.catch((err: NodeJS.ErrnoException) => {
			if (err.code === "ENOENT") return { raw: DEFAULT_IMAGE_RULES, missing: true }
			throw err
		})

	if (missing) {
		await mkdir(path.dirname(cfgPath), { recursive: true })
			.then(() => writeFile(cfgPath, DEFAULT_IMAGE_RULES, "utf-8"))
			.catch(() => console.warn("image rules: could not write default config"))
	}

	const parsed = JSON5.parse(raw)
	const compiled: CompiledImageRule[] = []

	const Schema = z.object({
		rules: z.array(
			z.object({
				type: z.string(),
				description: z.string(),
				category: z.string(),
				severity: z.enum(["low", "medium", "high"]),
				globs: z.array(z.string()),
				optimal: z.union([z.number(), z.object({ width: z.number(), height: z.number() })]).optional(),
				max: z.union([z.number(), z.object({ width: z.number(), height: z.number() })]).optional(),
				maxMipmaps: z.number().int().min(0).optional(),
			}),
		),
	})

	const result = Schema.safeParse(parsed)
	if (!result.success) {
		console.warn("image rules: config validation failed; no rules loaded")
		return compiled
	}

	for (const rule of result.data.rules) {
		compiled.push({
			type: rule.type,
			description: rule.description,
			category: rule.category,
			severity: rule.severity,
			globs: rule.globs,
			optimal: rule.optimal,
			max: rule.max,
			maxMipmaps: rule.maxMipmaps ?? 0,
			matchers: rule.globs.map((g) => new Glob(g)),
			optimalSize: resolveSize(rule.optimal),
			maxSize: resolveSize(rule.max),
		})
	}

	cachedRules = compiled
	return compiled
}

export class ImagesScanner implements Scanner {
	readonly id = "images"
	readonly weight = 60
	readonly findings: Finding[] = []
	readonly rawFindings: ImageFinding[] = []

	/** Lazy-loaded compiled rules, loaded once on first scan. */
	static rules: CompiledImageRule[] = []
	static loaded = false

	static async load(): Promise<void> {
		ImagesScanner.rules = await loadImageRules()
		ImagesScanner.loaded = true
	}

	report(modPath: string, sorter: ReportBuilder): ScannerResult {
		const totalSavings = this.rawFindings.reduce((sum, f) => sum + (f.potentialSavings ?? 0), 0)
		const modSize = sorter.modSize || 1
		const savings = { low: 0, medium: 0, high: 0 }
		for (const finding of this.rawFindings) {
			const sev = finding.severity ?? "medium"
			savings[sev] += finding.potentialSavings ?? 0
		}
		const weightedSavings = savings.low * 0.75 + savings.medium * 1 + savings.high * 1.25
		const wasteRatio = Math.min(weightedSavings / modSize, 1)
		const score = 100 * (1 - wasteRatio ** 0.5)

		return {
			id: this.id,
			score,
			weight: this.weight,
			savings: totalSavings,
			findings: this.groupFindings(this.rawFindings),
		}
	}

	async scanFile(modPath: string, sorter: ReportBuilder, fileEntry: PathEntry): Promise<void> {
		if (fileEntry.isDirectory) return
		if (!fileEntry.relativePath.endsWith(".png")) return
		const info = await loadImage(fileEntry)
		if (!info) return
		const [img, fileSize] = info
		// Find matching rules for this file
		const matchingRules = this.matchRules(fileEntry.relativePath)
		for (const rule of matchingRules) {
			// use globs to check if this file matches the rule's patterns
			if (!rule.matchers.some((m) => m.match(fileEntry.relativePath))) continue
			const finding = await checkImage(img, fileSize, fileEntry.relativePath, rule)
			if (finding) this.rawFindings.push(finding)
			break
		}
	}

	private matchRules(relativePath: string): CompiledImageRule[] {
		const matched: CompiledImageRule[] = []
		for (const rule of ImagesScanner.rules) {
			for (const matcher of rule.matchers) {
				if (matcher.match(relativePath)) {
					matched.push(rule)
					break
				}
			}
		}
		return matched
	}

	private groupFindings(findings: ImageFinding[]): Finding[] {
		const map: Record<
			string,
			{
				type: string
				description: string
				severity: "low" | "medium" | "high"
				potentialSavings: number
				paths: string[]
			}
		> = {}

		for (const f of findings) {
			const existing = map[f.type] ?? {
				type: f.type,
				description: f.description,
				severity: f.severity,
				potentialSavings: 0,
				paths: [],
			}
			existing.potentialSavings += f.potentialSavings
			existing.paths.push(f.path)
			map[f.type] = existing
		}

		return Object.values(map)
	}
}
