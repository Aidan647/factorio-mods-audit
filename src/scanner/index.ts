import { unzip } from "unzipit"
import fs from "fs/promises"
import type { ModPortal } from "../modportal"
import type { ModListItem, Release } from "../modportal/types"
import { ReportBuilder, type AuditReport } from "../report"
import path from "path"
import { scanFile, Verdict } from "../helpers/scanfile"
import { findModFolder, MetadataScanner } from "./metadata"
import { ClutterScanner, ImagesScanner } from "./files"
import { getSize } from "#/helpers/getFolder"
import type { Scanner, ScannerFactory } from "./base"
import { ScanIndex } from "./scan-index"
import { defaultConfig, type ScanConfig } from "../config"
import { DuplicatesScanner } from "./files/duplicates"
import walkDir from "./walkDir"

export class Orchestrator {
	private readonly cleanipAwait: Promise<void | string>
	constructor(
		readonly portal: ModPortal,
		private readonly cfg: ScanConfig = defaultConfig,
	) {
		// Ensure clean temp directory on construction
		this.cleanipAwait = fs
			.rm(this.cfg.cacheDir, { recursive: true, force: true })
			.then(() => fs.mkdir(this.cfg.cacheDir, { recursive: true }))
			.catch(() => undefined)
		this.index = new ScanIndex(this.cfg.indexPath)
	}

	private readonly index: ScanIndex
	private scanners: ScannerFactory[] = [ClutterScanner, MetadataScanner, ImagesScanner, DuplicatesScanner]

	async loadIndex(): Promise<this> {
		await this.index.load()
		return this
	}

	async scanMod(mod: ModListItem) {
		if (!mod.latest_release) throw new Error("No latest release found for mod: " + mod.name)
		if (this.index.has(mod.latest_release.sha1)) return "Scanned recently, skipping"

		const sorter = new ReportBuilder(mod, mod.latest_release, this.cfg.reportsDir)

		// Stage 1: Preflight — download, unpack, virus scan, find mod folder
		const modPath = await this.preflight(mod.latest_release, sorter)
		if (!modPath) return this.cleanup(sorter, true)

		const scanners = this.scanners.map((Factory) => new Factory())

		// Measure mod size
		await getSize(path.join(modPath, "..")) // gets total size of the unzipped folder, which is more relevant for size
			.then((size) => sorter.setModSize(size))
			.catch(() => {})

		// Stage 2 & 3: Orchestrator runs registered scanners
		await this.runScanners(modPath, sorter, scanners)

		this.generateReport(modPath, sorter, scanners)

		return this.cleanup(sorter, true)
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
		await this.cleanipAwait
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

	/** Run virus scan on the temp directory. Returns true if clean. */
	private async virusScan(tempPath: string, sorter: ReportBuilder): Promise<boolean> {
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

		const tempPath = path.join("./cache/tmp", `${sorter.modName}-${sorter.version}/`)
		await this.unzipToTemp(data, tempPath, sorter)

		if (!(await this.virusScan(tempPath, sorter))) return null

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

	async cleanup(sorter: ReportBuilder, save?: false): Promise<false>
	async cleanup(sorter: ReportBuilder, save: true): Promise<AuditReport>
	async cleanup(sorter: ReportBuilder, save = false): Promise<false | AuditReport> {
		const tempPath = path.join(this.cfg.cacheDir, `${sorter.modName}-${sorter.version}/`)
		await fs.rm(tempPath, { recursive: true, force: true })

		if (save) {
			const report = await sorter.saveReport()
			try {
				const dir =
					report.errors && report.errors.length > 0
						? `${this.cfg.reportsDir}/errored`
						: report.score < 100
							? `${this.cfg.reportsDir}/found`
							: `${this.cfg.reportsDir}/clean`
				const reportPath = `${dir}/${report.modName}-${report.version}.json`
				this.index.set(report.sha1, { reportPath, scannedAt: new Date().toISOString() })
				await this.index.save()
			} catch (err) {
				console.log("Failed to update scanned index:", err)
			}
			return report
		}
		return false
	}
}

export default Orchestrator
