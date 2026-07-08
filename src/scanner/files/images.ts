import type { Scanner, ScannerResult } from "../base"
import type { Finding, ReportBuilder } from "#/report"
import { checkImage, loadImage, type ImageFinding } from "./helpers/image-checks"
import type { PathEntry } from "../walkDir"
import { loadImageRules, type CompiledImageRule } from "./helpers/image-rules"
import { Rules } from "./helpers/rules"

export class ImagesScanner implements Scanner {
	readonly id = "images"
	readonly weight = 75
	readonly findings: Finding[] = []
	readonly rawFindings: ImageFinding[] = []

	/** Lazy-loaded compiled rules, loaded once on first scan. */
	static rules: Rules<CompiledImageRule> = new Rules<CompiledImageRule>()
	static loaded = false

	static async load(): Promise<void> {
		if (ImagesScanner.loaded) return
		await ImagesScanner.rules.loadRules(loadImageRules)
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
