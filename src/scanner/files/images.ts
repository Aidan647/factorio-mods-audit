import { Glob, JSON5 } from "bun"
import { z } from "zod"
import path from "node:path"
import { readdir, readFile } from "node:fs/promises"
import { Scanner, type ScannerResult } from "../base"
import type { Finding, ReportBuilder } from "#/report"
import { checkImage, loadImage, type ImageFinding } from "./image-checks"

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

	const cfgPath = process.env.IMAGE_RULES_PATH || path.join(process.cwd(), "config/image-rules.json5")
	const raw = await readFile(cfgPath, "utf-8").catch(() => "{}")
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

/**
 * Scanner that validates image dimensions, paths, and compression.
 *
 * Checks per rule:
 *  - Images exceeding optimal dimensions (warning)
 *  - Images exceeding max dimensions (finding with resize+recompress savings estimate)
 *  - Mipmap levels exceeding maxMipmaps
 *  - Non-power-of-2 dimensions (mipmap-unfriendly)
 */
export class ImagesScanner extends Scanner {
	readonly id = "images"
	readonly weight = 60

	/** Lazy-loaded compiled rules, loaded once on first scan. */
	static rules: CompiledImageRule[] | null = null

	async scan(modPath: string, sorter: ReportBuilder): Promise<ScannerResult> {
		if (!ImagesScanner.rules) ImagesScanner.rules = await loadImageRules()

		const rawFindings = await this.walkImages(modPath)
		const totalSavings = rawFindings.reduce((sum, f) => sum + (f.potentialSavings ?? 0), 0)

		const modSize = sorter.modSize || 1
		const savings = { low: 0, medium: 0, high: 0 }
		for (const finding of rawFindings) {
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
			findings: this.groupFindings(rawFindings),
		}
	}

	private async walkImages(basePath: string): Promise<ImageFinding[]> {
		const findings: ImageFinding[] = []
		await this.walkDir(basePath, ".", findings)
		return findings
	}

	private async walkDir(basePath: string, currentPath: string, findings: ImageFinding[]): Promise<void> {
		const pathToScan = path.join(basePath, currentPath)
		const entries = await readdir(pathToScan, { withFileTypes: true }).catch(() => [])

		for (const entry of entries) {
			const entryPath = path.join(pathToScan, entry.name)
			const relativePath = path.relative(basePath, entryPath)

			if (entry.isDirectory()) {
				await this.walkDir(basePath, relativePath, findings)
				continue
			}

			if (!entry.name.endsWith(".png")) continue

			const info = await loadImage(entryPath, relativePath)
			if (!info) continue
			const [img, fileSize] = info
			// Find matching rules for this file
			const matchingRules = this.matchRules(relativePath)
			for (const rule of matchingRules) {
				// use globs to check if this file matches the rule's patterns
				if (!rule.matchers.some((m) => m.match(relativePath))) continue
				findings.push(...(await checkImage(img, fileSize, relativePath, rule)))
				break
			}
		}
	}

	private matchRules(relativePath: string): CompiledImageRule[] {
		const matched: CompiledImageRule[] = []
		for (const rule of ImagesScanner.rules ?? []) {
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
