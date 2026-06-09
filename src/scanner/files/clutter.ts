import { Glob, JSON5 } from "bun"
import { z } from "zod"
import path from "node:path"
import { readFile, readdir } from "node:fs/promises"
import { Scanner, type ScannerResult } from "../base"
import type { Finding } from "#/report"
import { getSize } from "#/helpers/getFolder"

type ClutterRule = {
	type: string
	description: string
	glob: string
	category?: string
	severity?: "low" | "medium" | "high"
	exceptions?: string[]
}

type CompiledClutterRule = ClutterRule & {
	matcher: Glob
	matcherExceptions?: Glob
}

async function loadClutterRules(): Promise<CompiledClutterRule[]> {
	const cfgPath = process.env.CLUTTER_RULES_PATH || path.join(process.cwd(), "config/clutter-rules.json5")
	const raw = await readFile(cfgPath, "utf-8").catch(() => "{}")
	const parsed = JSON5.parse(raw)
	const compiled: CompiledClutterRule[] = []

	const Schema = z.object({
		rules: z.array(
			z.object({
				type: z.string(),
				description: z.string(),
				globs: z.array(z.string()),
				category: z.string().optional(),
				severity: z.enum(["low", "medium", "high"]).optional(),
				exceptions: z.array(z.string()).optional(),
			}),
		),
	})

	const parsedCfg = Schema.safeParse(parsed)
	if (!parsedCfg.success) {
		console.warn("clutter rules: config validation failed; no rules loaded")
		return compiled
	}

	for (const rule of parsedCfg.data.rules) {
		const type = rule.type
		const description = rule.description
		const category = rule.category
		const severity = rule.severity
		const exceptions = rule.exceptions
		for (const g of rule.globs) {
			compiled.push({
				type,
				description,
				glob: g,
				category,
				severity,
				exceptions,
				matcher: new Glob(g),
			})
		}
	}
	return compiled
}

/**
 * Scanner that finds clutter/development files in the mod directory.
 */
export class ClutterScanner extends Scanner {
	readonly id = "clutter"
	readonly weight = 40

	/** Lazy-loaded compiled rules, loaded once on first scan. */
	private rules: CompiledClutterRule[] | null = null

	async scan(modPath: string): Promise<ScannerResult> {
		if (!this.rules) this.rules = await loadClutterRules()
		const findings = await this.walkDirectory(modPath)
		const grouped = this.groupFindings(findings)
		const totalSavings = grouped.reduce((sum, f) => sum + (f.potentialSavings ?? 0), 0)

		// Score: start at 100, deduct per finding type
		const score = Math.max(0, 100 - grouped.length * 20)
		return { id: this.id, score, weight: this.weight, savings: totalSavings, findings: grouped }
	}

	private groupFindings(findings: Finding[]): Finding[] {
		const findingsByType: Record<
			string,
			{
				type: string
				description: string
				severity?: "low" | "medium" | "high"
				potentialSavings: number
				paths: string[]
			}
		> = {}

		for (const finding of findings) {
			const type = finding.type
			const fin = findingsByType[type] ?? {
				type,
				description: finding.description,
				severity: finding.severity,
				potentialSavings: 0,
				paths: [],
			}
			if (!fin.severity && finding.severity) fin.severity = finding.severity
			if (finding.potentialSavings) fin.potentialSavings += finding.potentialSavings
			if (finding.paths) fin.paths.push(...finding.paths)
			if (!findingsByType[type]) findingsByType[type] = fin
		}

		return Object.values(findingsByType)
	}

	private async walkDirectory(
		basePath: string,
		currentPath: string = ".",
		findings: Finding[] = [],
	): Promise<Finding[]> {
		const pathToScan = path.join(basePath, currentPath)
		const entries = await readdir(pathToScan, { withFileTypes: true }).catch(() => [])
		for (const entry of entries) {
			const entryPath = path.join(pathToScan, entry.name)
			const relativePath = path.relative(basePath, entryPath)
			const matchedRule = this.matchClutterRule(relativePath, entry.name)
			if (matchedRule) {
				findings.push({
					type: `clutter:${matchedRule.type}`,
					description: matchedRule.description,
					severity: matchedRule.severity,
					paths: [relativePath],
					potentialSavings: await getSize(entryPath),
				})
				continue
			}
			if (entry.isDirectory()) {
				await this.walkDirectory(basePath, relativePath, findings)
			}
		}
		return findings
	}

	private matchClutterRule(relativePath: string, name: string): ClutterRule | null {
		const rules = this.rules ?? []
		for (const rule of rules) {
			if (!rule.matcher.match(relativePath) && !rule.matcher.match(name)) continue
			if (rule.exceptions) {
				let excluded = false
				for (const exc of rule.exceptions) {
					if (new Glob(exc).match(relativePath) || new Glob(exc).match(name)) {
						excluded = true
						break
					}
				}
				if (excluded) continue
			}
			return rule
		}
		return null
	}
}
