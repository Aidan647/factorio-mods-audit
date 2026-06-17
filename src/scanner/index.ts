import { unzip } from "unzipit"
import fs from "fs/promises"
import type { ModPortal } from "../modportal"
import type { ModListItem, Release } from "../modportal/types"
import { ReportBuilder, type AuditReport, SCANNER_VERSION } from "../report"
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
import { MixedCache } from "../helpers/cache"
import { LocaleScanner } from "./locale"

export class Orchestrator {
	private readonly tmpCleanup: Promise<void | string>

	private constructor(
		readonly portal: ModPortal,
		readonly reportCache: MixedCache<AuditReport>,
		private readonly cfg: ScanConfig,
	) {
		// Clean tmp dir on construction
		this.tmpCleanup = fs
			.rm(this.cfg.tmpDir, { recursive: true, force: true })
			.then(() => fs.mkdir(this.cfg.tmpDir, { recursive: true }))
			.catch(() => undefined)
	}

	/**
	 * Create an Orchestrator instance with async initialization.
	 */
	static async create(portal: ModPortal, cfg: ScanConfig = loadConfig()): Promise<Orchestrator> {
		const reportCache = await MixedCache.create<AuditReport>({
			memoryExpiryMs: 24 * 60 * 60 * 1000, // 1d
			diskExpiryMs: 31 * 24 * 60 * 60 * 1000, // 31d
			cacheDir: cfg.reportsDir,
			extension: ".json.zst",
			minMemorySize: 200,
			maxMemoryMB: 550,
			deserialize: async (data) => {
				try {
					const report = JSON.parse((await Bun.zstdDecompress(data)).toString()) as AuditReport
					if (report.scannerVersion !== SCANNER_VERSION) return undefined
					if (report.errors && report.errors.length > 0) return undefined
					return report
				} catch {
					return undefined
				}
			},
			serialize: (report) => Bun.zstdCompress(JSON.stringify(report), { level: 5 }),
			diskPruneIntervalMs: 24 * 60 * 60 * 1000, // 24h
			memoryPruneIntervalMs: 30 * 60 * 1000, // 30min
			memoryCheckIntervalMs: 10 * 1000, // 10s
			splitFolders: [2],
			verifyOnRead: true,
			writePolicy: "through",
			skipCacheLoading: cfg.skipLoadingScanCache,
		})
		const orchestrator = new Orchestrator(portal, reportCache, cfg)
		await orchestrator.loadScanners()
		return orchestrator
	}

	private scanners: ScannerFactory[] = [
		ClutterScanner,
		MetadataScanner,
		ImagesScanner,
		DuplicatesScanner,
		ChangelogScanner,
		LocaleScanner,
	]

	private async loadScanners(): Promise<this> {
		for (const factory of this.scanners) {
			if (factory.loaded) continue
			if (factory.load) await factory.load()
			if (!factory.loaded) {
				console.error(`Scanner ${factory.name} did loaded`)
				process.exit(1)
			}
		}
		return this
	}

	async scanModFromBuffer(mod: ModListItem, buffer: Buffer): Promise<AuditReport> {
		if (!mod.latest_release) throw new Error("No latest release found for mod: " + mod.name)

		await this.loadScanners()
		const sorter = new ReportBuilder(mod, mod.latest_release, this.cfg.reportsDir)

		const modPath = await this.preflight(mod.latest_release, sorter, buffer)
		if (!modPath) {
			await this.cleanup(sorter)
			return sorter.saveReport()
		}

		const scanners = this.scanners.map((Factory) => new Factory())

		await getSize(path.join(modPath, ".."))
			.then((size) => sorter.setModSize(size))
			.catch(() => {})

		await this.runScanners(modPath, sorter, scanners)
		this.generateReport(modPath, sorter, scanners)

		const report = sorter.saveReport()
		await this.cleanup(sorter)
		return report
	}

	async scanMod(mod: ModListItem): Promise<AuditReport> {
		if (!mod.latest_release) throw new Error("No latest release found for mod: " + mod.name)
		const cached = await this.reportCache.get(mod.latest_release.sha1)
		if (cached) return cached

		await this.loadScanners()
		const sorter = new ReportBuilder(mod, mod.latest_release, this.cfg.reportsDir)

		// Stage 1: Preflight — download, unpack, virus scan, find mod folder
		const modPath = await this.preflight(mod.latest_release, sorter)
		if (!modPath) {
			const report = await this.save(sorter)
			await this.cleanup(sorter)
			return report
		}

		const scanners = this.scanners.map((Factory) => new Factory())

		// Measure mod size as walkdir may not be called
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
	 * If `buffer` is provided, use it directly instead of downloading.
	 * Returns the mod folder path or null if the mod is unrecoverable.
	 */
	private async preflight(release: Release, sorter: ReportBuilder, buffer?: Buffer): Promise<string | null> {
		const data = buffer ?? (await this.downloadRelease(release, sorter))
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
		// need to scan files sequentially to allow scanners to mark files as "skip"
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
		this.reportCache.set(report.sha1, report)
		return report
	}

	async cleanup(sorter: ReportBuilder): Promise<void> {
		const tempPath = path.join(this.cfg.tmpDir, `${sorter.modName}-${sorter.version}/`)
		await fs.rm(tempPath, { recursive: true, force: true })
	}
}

export default Orchestrator
