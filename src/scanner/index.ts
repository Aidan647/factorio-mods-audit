import { unzip } from "unzipit"
import fs from "fs/promises"
import type { ModPortal } from "../modportal"
import type { ModListItem, Release } from "../modportal/types"
import { ReportBuilder, type AuditReport, SCANNER_VERSION } from "../report"
import { saveReportToDisk } from "../report/save"
import path from "path"
import { scanFile, Verdict } from "../helpers/scanfile"
import { findModFolder, MetadataScanner } from "./metadata"
import { ClutterScanner, ImagesScanner } from "./files"
import { getSize } from "#/helpers/getFolder"
import type { Scanner, ScannerFactory } from "./base"
import { ScanIndex } from "./scan-index"
import { loadConfig, type ScanConfig } from "../config"
import { DuplicatesScanner } from "./files/duplicates"
import { ChangelogScanner } from "./changelog"
import walkDir from "./walkDir"
import { MemoryCache } from "../helpers/cache"

export class Orchestrator {
	private readonly tmpCleanup: Promise<void | string>
	private readonly reportCache: MemoryCache<AuditReport>
	constructor(
		readonly portal: ModPortal,
		private readonly cfg: ScanConfig = loadConfig(),
	) {
		// Clean tmp dir on construction
		this.tmpCleanup = fs
			.rm(this.cfg.tmpDir, { recursive: true, force: true })
			.then(() => fs.mkdir(this.cfg.tmpDir, { recursive: true }))
			.catch(() => undefined)
		this.index = new ScanIndex(this.cfg.indexPath)
		this.reportCache = new MemoryCache<AuditReport>({
			expiryMs: 300 * 60 * 1000, // 5h
			maxSize: 500,
			checkIntervalMs: 5 * 60 * 1000, // 5m
			maxMemoryMB: 500,
		})
	}

	private readonly index: ScanIndex
	private scanners: ScannerFactory[] = [
		ClutterScanner,
		MetadataScanner,
		ImagesScanner,
		DuplicatesScanner,
		ChangelogScanner,
	]

	async loadIndex(): Promise<this> {
		await this.index.load()
		return this
	}

	async scanMod(mod: ModListItem): Promise<AuditReport | null> {
		if (!mod.latest_release) throw new Error("No latest release found for mod: " + mod.name)
		if (this.index.has(mod.latest_release.sha1)) {
			const cached = this.loadCachedReport(mod.latest_release.sha1)
			if (cached) return cached
		}

		const sorter = new ReportBuilder(mod, mod.latest_release, this.cfg.reportsDir)

		// Stage 1: Preflight — download, unpack, virus scan, find mod folder
		const modPath = await this.preflight(mod.latest_release, sorter)
		if (!modPath) {
			await this.save(sorter)
			await this.cleanup(sorter)
			return null
		}

		const scanners = this.scanners.map((Factory) => new Factory())

		// Measure mod size
		await getSize(path.join(modPath, "..")) // gets total size of the unzipped folder, which is more relevant for size
			.then((size) => sorter.setModSize(size))
			.catch(() => {})

		// Stage 2 & 3: Orchestrator runs registered scanners
		await this.runScanners(modPath, sorter, scanners)

		this.generateReport(modPath, sorter, scanners)

		const report = await this.save(sorter)
		await this.cleanup(sorter)
		return report
	}

	/** Try to load a previously-saved report from memory cache or disk. */
	private async loadCachedReport(sha1: string): Promise<AuditReport | null> {
		const cached = this.reportCache.get(sha1)
		if (cached) return cached

		const entry = this.index.get(sha1)
		if (!entry) return null

		return fs
			.readFile(entry.reportPath, "utf-8")
			.then((raw) => {
				const report = JSON.parse(raw) as AuditReport
				if (report.scannerVersion !== SCANNER_VERSION) return null
				this.reportCache.set(sha1, report)
				return report
			})
			.catch(() => null)
	}

	/** Download a release, returning the raw buffer or null on failure. */
	private async downloadRelease(release: Release, sorter: ReportBuilder): Promise<Buffer | null> {
		return this.portal.downloadRelease(release).catch((err: Error) => {
			if (err.message === "File is malicious")
				sorter.addPreflightFinding({
					type: "MaliciousFile",
					description: `The mod's latest release (${release.version}) was flagged as malicious by the virus scanner.`,
				})
			else sorter.addError(err)
			return null
		})
	}

	/** Unzip a buffer into a temp directory, checking for path traversal. */
	private async unzipToTemp(data: Buffer, tempPath: string, sorter: ReportBuilder): Promise<void> {
		await this.tmpCleanup
		await fs.mkdir(tempPath, { recursive: true })
		const { entries } = await unzip(data)
		for (const [entryPath, entry] of Object.entries(entries)) {
			if (entry.isDirectory) continue

			if (path.resolve(entryPath).startsWith("..") || entryPath.startsWith("/")) {
				sorter.addPreflightFinding({
					type: "PathTraversal",
					description: `The mod contains a file with a potentially dangerous path.`,
					paths: [entryPath],
				})
				continue
			}
			const outputPath = path.join(tempPath, entryPath)
			await fs.mkdir(path.dirname(outputPath), { recursive: true })
			const arrayBuffer = await entry.arrayBuffer()
			await fs.writeFile(outputPath, Buffer.from(arrayBuffer))
		}
	}

	/** Run virus scan on the temp directory. Returns true if clean or disabled. */
	private async virusScan(tempPath: string, sorter: ReportBuilder): Promise<boolean> {
		if (this.cfg.disableClamAv) return true
		const verdict = await scanFile(tempPath)
		if (verdict === Verdict.Malicious) {
			sorter.addPreflightFinding({
				type: "MaliciousFile",
				description: `The mod's latest release was flagged as malicious by the virus scanner.`,
			})
			return false
		}
		if (verdict === Verdict.ScanError) {
			sorter.addError(new Error("Error scanning mod files for malware"))
			return false
		}
		return true
	}

	/**
	 * Stage 1: Download, unpack, virus scan, and locate the mod folder.
	 * Returns the mod folder path or null if the mod is unrecoverable.
	 */
	private async preflight(release: Release, sorter: ReportBuilder): Promise<string | null> {
		const data = await this.downloadRelease(release, sorter)
		if (!data) return null

		const tempPath = path.join(this.cfg.tmpDir, `${sorter.modName}-${sorter.version}/`)
		await this.unzipToTemp(data, tempPath, sorter)

		if (!this.cfg.disableClamAv) {
			if (!(await this.virusScan(tempPath, sorter))) return null
		}

		const folderResult = await findModFolder(tempPath, sorter.modName, sorter.version)
		if (!folderResult) return null

		for (const finding of folderResult.preflightFindings) {
			sorter.addPreflightFinding(finding)
		}
		return folderResult.folderPath
	}

	private addError(sorter: ReportBuilder, err: unknown, context?: string) {
		if (err instanceof Error) {
			return sorter.addError(err)
		}
		sorter.addError(new Error(`Unknown error${context ? ` in ${context}` : ""}: ${String(err)}`))
	}

	/**
	 * Stage 2: Run all registered scanners.
	 */
	private async runScanners(modPath: string, sorter: ReportBuilder, scanners: Scanner[]): Promise<void> {
		for (const scanner of scanners) {
			await scanner.scan?.(modPath, sorter).catch((err) => this.addError(sorter, err, `scanner ${scanner.id}`))
		}
		const generator = walkDir(modPath)
		let next = await generator.next()
		while (!next.done) {
			const pathEntry = next.value

			let skip = false
			for (const scanner of scanners) {
				const result = await scanner.scanFile?.(modPath, sorter, pathEntry).catch((err) => {
					this.addError(
						sorter,
						err,
						`scanner ${scanner.id} on file ${pathEntry.relativePath} (${sorter.modName} ${sorter.version})`,
					)
				})
				if (result === true) {
					skip = true
					break
				}
			}
			if (!pathEntry.isDirectory) pathEntry.unread()
			next = await generator.next(skip)
		}
	}

	// Stage 3: Cleanup temp files and save report
	generateReport(modPath: string, sorter: ReportBuilder, scanners: Scanner[]): void {
		for (const scanner of scanners) {
			const result = scanner.report(modPath, sorter)
			result.score = Math.max(0, Math.min(100, result.score))
			sorter.addScannerResult(result)
		}
	}

	async save(sorter: ReportBuilder): Promise<AuditReport> {
		const report = sorter.saveReport()
		const reportPath = await saveReportToDisk(report, this.cfg.reportsDir).catch((err) =>
			console.log("Failed to save report to disk:", err),
		)
		if (reportPath) {
			this.index.set(report.sha1, { reportPath, scannedAt: new Date().toISOString() })
			this.reportCache.set(report.sha1, report)
			await this.index.save().catch((err) => console.log("Failed to save scan index:", err))
		}
		return report
	}

	async cleanup(sorter: ReportBuilder): Promise<void> {
		const tempPath = path.join(this.cfg.tmpDir, `${sorter.modName}-${sorter.version}/`)
		await fs.rm(tempPath, { recursive: true, force: true })
	}
}

export default Orchestrator
