import path from "node:path"
import type { Scanner, ScannerResult } from "../base"
import type { Finding, ReportBuilder } from "#/report"
import { ClutterScanner } from "./clutter"
import type { FileEntry, PathEntry } from "../walkDir"

type DublicateEntry = {
	relativePath: string
	absolutePath: string
	size: number
}

/**
 * Scanner that finds duplicate files by content hash.
 *
 * Files matching clutter rules are ignored since they are expected
 * to be non-essential and their duplication is already reported.
 */
export class DuplicatesScanner implements Scanner {
	readonly id = "duplicates"
	readonly weight = 95
	readonly findings: Finding[] = []
	readonly duplicateGroups: Map<string, DublicateEntry[]> = new Map()

	static loaded = false

	static async load(): Promise<void> {
		if (!ClutterScanner.loaded) await ClutterScanner.load()
		if (!ClutterScanner.loaded) return console.warn("DuplicatesScanner: failed to load clutter rules.")
		DuplicatesScanner.loaded = ClutterScanner.loaded
	}

	report(_modPath: string, sorter: ReportBuilder): ScannerResult {
		const findings: Finding[] = []
		let totalSavings = 0

		for (const group of this.findDuplicates(this.duplicateGroups)) {
			const groupSavings = (group.length - 1) * (group[0]?.size ?? 0)
			totalSavings += groupSavings

			const severity = groupSavings > 1_000_000 ? "high" : groupSavings > 100_000 ? "medium" : "low"

			findings.push({
				type: "duplicates:content",
				description: `Duplicate files found.`,
				severity,
				paths: group.map((f) => f.relativePath),
				potentialSavings: groupSavings,
			})
		}
		findings.sort((a, b) => (b.potentialSavings ?? 0) - (a.potentialSavings ?? 0))
		const modSize = sorter.modSize || 1
		const wasteRatio = Math.min(totalSavings / modSize, 1)
		const score = 100 * (1 - wasteRatio ** 0.3)

		return { id: this.id, score, weight: this.weight, savings: totalSavings, findings }
	}

	async scanFile(_modPath: string, _sorter: ReportBuilder, fileEntry: PathEntry): Promise<void> {
		if (fileEntry.isDirectory) return
		if (ClutterScanner.matchRules(fileEntry.relativePath, path.basename(fileEntry.relativePath))) return

		await this.hashFile(fileEntry)
	}

	private async hashFile(file: FileEntry): Promise<void> {
		const buffer = await file.read().catch(() => null)
		if (!buffer) return
		const hash = Bun.hash(buffer).toString(16)
		const existing = this.duplicateGroups.get(hash)
		const entry: DublicateEntry = {
			relativePath: file.relativePath,
			absolutePath: file.absolutePath,
			size: buffer.length,
		}
		if (existing) existing.push(entry)
		else this.duplicateGroups.set(hash, [entry])
	}

	/**
	 * Extract groups with more than one file sharing the same hash.
	 */
	private findDuplicates(hashMap: Map<string, DublicateEntry[]>): DublicateEntry[][] {
		const groups: DublicateEntry[][] = []
		for (const entries of hashMap.values()) {
			if (entries.length > 1) groups.push(entries)
		}
		return groups
	}
}
