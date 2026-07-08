import { Glob } from "bun"
import path from "node:path"
import { readdir } from "node:fs/promises"
import type { Scanner, ScannerResult } from "../base"
import type { Finding, ReportBuilder } from "#/report"
import { getSize } from "#/helpers/getFolder"
import type { PathEntry } from "../walkDir"
import { loadClutterRules, type CompiledClutterRule } from "./helpers/clutter-rules"
import { Rules } from "./helpers/rules"

/**
 * Scanner that finds clutter/development files in the mod directory.
 */
export class ClutterScanner implements Scanner {
	readonly id = "clutter"
	readonly weight = 95
	readonly findings: Finding[] = []

	/** Lazy-loaded compiled rules, loaded once on first scan. */
	static readonly rules: Rules<CompiledClutterRule> = new Rules<CompiledClutterRule>()
	static loaded = false

	static async load(): Promise<void> {
		if (ClutterScanner.loaded) return
		ClutterScanner.rules.loadRules(loadClutterRules)
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
		const matchedRule = ClutterScanner.matchRules(pathEntry.relativePath, path.basename(pathEntry.relativePath))
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

	static matchRules(relativePath: string, name: string): CompiledClutterRule | null {
		for (const rule of ClutterScanner.rules) {
			if (this.matchRule(rule, relativePath, name)) return rule
		}
		return null
	}
	private static matchRule(rule: CompiledClutterRule, relativePath: string, name: string): boolean {
		if (this.matchExeptions(rule, relativePath, name)) return false
		for (const matcher of rule.matchers) if (matcher.match(relativePath) || matcher.match(name)) return true
		return false
	}
	private static matchExeptions(rule: CompiledClutterRule, relativePath: string, name: string): boolean {
		for (const exception of rule.matcherExceptions)
			if (exception.match(relativePath) || exception.match(name)) return true
		return false
	}
}
