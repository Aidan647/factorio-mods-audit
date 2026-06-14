import { Glob } from "bun"
import path from "node:path"
import { readdir } from "node:fs/promises"
import type { Scanner, ScannerResult } from "../base"
import type { Finding, ReportBuilder } from "#/report"
import { getSize } from "#/helpers/getFolder"
import type { PathEntry } from "../walkDir"
import { loadClutterRules, type CompiledClutterRule } from "./helpers/default-clutter-rules"


/**
 * Scanner that finds clutter/development files in the mod directory.
 */
export class ClutterScanner implements Scanner {
	readonly id = "clutter"
	readonly weight = 80
	readonly findings: Finding[] = []

	/** Lazy-loaded compiled rules, loaded once on first scan. */
	static rules: CompiledClutterRule[] = []
	static loaded = false

	static async load(): Promise<void> {
		ClutterScanner.rules = await loadClutterRules()
		ClutterScanner.loaded = true
	}

	async scan(modPath: string, sorter: ReportBuilder): Promise<void> {
		const parentDir = path.join(modPath, "..")
		const modName = path.basename(modPath)
		const entries = await readdir(parentDir, { withFileTypes: true }).catch(() => [])

		for (const entry of entries) {
			if (entry.name === modName) continue
			const entryPath = path.join(parentDir, entry.name)
			const relativePath = path.relative(modPath, entryPath)
			this.findings.push({
				type: "clutter:extra-parent-entry",
				description: `Unexpected file/folder found alongside mod directory in zip: ${entry.name}`,
				severity: "high",
				paths: [relativePath],
				potentialSavings: await getSize(entryPath).catch(() => 0),
			})
		}
	}

	report(modPath: string, sorter: ReportBuilder): ScannerResult {
		const grouped = this.groupFindings()
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
	async scanFile(modPath: string, sorter: ReportBuilder, pathEntry: PathEntry): Promise<boolean> {
		const matchedRule = this.matchClutterRule(pathEntry.relativePath, path.basename(pathEntry.relativePath))
		if (matchedRule) {
			this.findings.push({
				type: `clutter:${matchedRule.type}`,
				description: matchedRule.description,
				severity: matchedRule.severity,
				paths: [pathEntry.relativePath],
				potentialSavings: await pathEntry.size().catch(() => 0),
			})
			return true
		}
		return false
	}


	private groupFindings(): Finding[] {
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

		for (const finding of this.findings) {
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

	private matchClutterRule(relativePath: string, name: string): CompiledClutterRule | null {
		for (const rule of ClutterScanner.rules) {
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
