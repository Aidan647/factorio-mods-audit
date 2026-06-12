import { Glob } from "bun"
import path from "node:path"
import { readdir, readFile } from "node:fs/promises"
import { Scanner, type ScannerResult } from "../base"
import type { Finding, ReportBuilder } from "#/report"
import { getSize } from "#/helpers/getFolder"
import { ClutterScanner, loadClutterRules } from "./clutter"

type FileEntry = {
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
export class DuplicatesScanner extends Scanner {
	readonly id = "duplicates"
	readonly weight = 70

	async scan(modPath: string, sorter: ReportBuilder): Promise<ScannerResult> {
		// Ensure clutter rules are loaded so we can skip clutter files
		if (!ClutterScanner.rules) ClutterScanner.rules = await loadClutterRules()

		const files = await this.collectFiles(modPath)
		const hashMap = await this.hashFiles(files)
		const duplicateGroups = this.findDuplicates(hashMap)

		const findings: Finding[] = []
		let totalSavings = 0

		for (const group of duplicateGroups) {
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
		const score = 100 * (1 - wasteRatio ** 0.25)

		return { id: this.id, score, weight: this.weight, savings: totalSavings, findings }
	}

	/**
	 * Recursively collect all files, skipping those that match clutter rules.
	 */
	private async collectFiles(modPath: string): Promise<FileEntry[]> {
		const files: FileEntry[] = []
		await this.walkDir(modPath, ".", files)
		return files
	}

	private async walkDir(basePath: string, currentPath: string, files: FileEntry[]): Promise<void> {
		const pathToScan = path.join(basePath, currentPath)
		const entries = await readdir(pathToScan, { withFileTypes: true }).catch(() => [])

		for (const entry of entries) {
			const entryPath = path.join(pathToScan, entry.name)
			const relativePath = path.relative(basePath, entryPath)

			if (entry.isDirectory()) {
				await this.walkDir(basePath, relativePath, files)
				continue
			}

			if (this.isClutter(relativePath, entry.name)) continue

			const size = await getSize(entryPath).catch(() => 0)
			files.push({ relativePath, absolutePath: entryPath, size })
		}
	}

	/**
	 * Check if a path matches any loaded clutter rule.
	 */
	private isClutter(relativePath: string, name: string): boolean {
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
			return true
		}
		return false
	}

	/**
	 * Hash all files by content and group by hash.
	 */
	private async hashFiles(files: FileEntry[]): Promise<Map<string, FileEntry[]>> {
		const hashMap = new Map<string, FileEntry[]>()

		for (const file of files) {
			const buffer = await readFile(file.absolutePath).catch(() => null)
			if (!buffer) continue
			const hash = Bun.hash(buffer).toString(16)
			const existing = hashMap.get(hash)
			if (existing) {
				existing.push(file)
			} else {
				hashMap.set(hash, [file])
			}
		}

		return hashMap
	}

	/**
	 * Extract groups with more than one file sharing the same hash.
	 */
	private findDuplicates(hashMap: Map<string, FileEntry[]>): FileEntry[][] {
		const groups: FileEntry[][] = []
		for (const entries of hashMap.values()) {
			if (entries.length > 1) groups.push(entries)
		}
		return groups
	}
}
