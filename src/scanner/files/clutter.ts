import { Glob, JSON5 } from "bun"
import { z } from "zod"
import path from "node:path"
import { readFile, readdir } from "node:fs/promises"
import { Scanner, type ScannerResult } from "../base"
import type { Finding, ReportBuilder } from "#/report"
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

export async function loadClutterRules(): Promise<CompiledClutterRule[]> {
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
	readonly weight = 80

	/** Lazy-loaded compiled rules, loaded once on first scan. */
	static rules: CompiledClutterRule[] | null = null

	async scan(modPath: string, sorter: ReportBuilder): Promise<ScannerResult> {
		if (!ClutterScanner.rules) ClutterScanner.rules = await loadClutterRules()
		const findings = await this.walkDirectory(modPath)
		const extraFindings = await this.scanParentDir(modPath)
		findings.push(...extraFindings)
		const grouped = this.groupFindings(findings)
		const totalSavings = grouped.reduce((sum, f) => sum + (f.potentialSavings ?? 0), 0)

		const modSize = sorter.modSize || 1 // Avoid division by zero
		// Score: % of mod size of potential savings waighted by severity (high=1.25, medium=1, low=0.75)
		const savings = {
			low: 0,
			medium: 0,
			high: 0,
		}
		for (const finding of grouped) {
			const sev = finding.severity ?? "medium"
			savings[sev] += finding.potentialSavings ?? 0
		}
		const weightedSavings = savings.low * 0.75 + savings.medium * 1 + savings.high * 1.25
		const wasteRatio = Math.min(weightedSavings / modSize, 1)
		const score = 100 * (1 - wasteRatio ** 0.3)
		return { id: this.id, score, weight: this.weight, savings: totalSavings, findings: grouped }

	}

	/**
	 * Scan the parent directory for entries that aren't the mod folder itself.
	 * These are files/folders accidentally included at the wrong zip level.
	 */
	private async scanParentDir(modPath: string): Promise<Finding[]> {
		const findings: Finding[] = []
		const parentDir = path.join(modPath, "..")
		const modName = path.basename(modPath)
		const entries = await readdir(parentDir, { withFileTypes: true }).catch(() => [])

		for (const entry of entries) {
			if (entry.name === modName) continue
			const entryPath = path.join(parentDir, entry.name)
			const relativePath = path.relative(modPath, entryPath)
			findings.push({
				type: "clutter:extra-parent-entry",
				description: `Unexpected file/folder found alongside mod directory in zip: ${entry.name}`,
				severity: "high",
				paths: [relativePath],
				potentialSavings: await getSize(entryPath).catch(() => 0),
			})
		}
		return findings
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
		const rules = ClutterScanner.rules ?? []
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
