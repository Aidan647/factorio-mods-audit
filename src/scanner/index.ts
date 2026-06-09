import { unzip } from "unzipit"
import fs from "fs/promises"
import { createHash } from "crypto"
import type { ModPortal } from "../modportal"
import type { ModListItem, Release } from "../modportal/types"
import { AuditReportBuilder, type AuditReport, type Finding } from "../findingsSorter"
import path from "path"
import { scanFile, Verdict } from "../helpers/scanfile"
import { analyzeInfoJson } from "./infojson"
import { scanForFiles } from "./files"
import { getSize } from "#/helpers/getFolder"

await fs.rm("./cache/tmp", { recursive: true, force: true })
await fs.mkdir("./cache/tmp", { recursive: true })

export class Scanner {
	constructor(readonly portal: ModPortal) {}

	private static readonly INDEX_PATH = "./cache/scanned.json"
	private scannedIndex: Record<string, { reportPath: string; scannedAt: string }> = {}

	async loadIndex(): Promise<Record<string, { reportPath: string; scannedAt: string }>> {
		await fs
			.readFile(Scanner.INDEX_PATH, "utf-8")
			.then((data) => {
				this.scannedIndex = JSON.parse(data)
				console.log(`Loaded scanned index with ${Object.keys(this.scannedIndex).length} entries`)
			})
			.catch((err) => {
				if (err.code === "ENOENT") {
					this.scannedIndex = {}
				} else {
					console.log("Error loading scanned index:", err)
					this.scannedIndex = {}
				}
			})
		return this.scannedIndex
	}

	private async saveIndex() {
		await fs.mkdir(path.dirname(Scanner.INDEX_PATH), { recursive: true })
		await fs.writeFile(Scanner.INDEX_PATH, JSON.stringify(this.scannedIndex, null, 2))
	}

	async scanMod(mod: ModListItem) {
		if (!mod.latest_release) throw new Error("No latest release found for mod: " + mod.name)
		if (mod.latest_release.sha1 in this.scannedIndex) return "Scanned recently, skipping"

		const sorter = new AuditReportBuilder(mod, mod.latest_release)
		const downloadResult = await this.downloadAndUnpack(mod.latest_release, sorter)
		// If downloadResult is false, it means the mod was flagged as malicious or there was an error during scanning/unpacking.
		// In either case, we should save the report and not proceed further.
		if (!downloadResult) return this.cleanup(sorter, true)
		const modPath = await analyzeInfoJson(sorter)
		if (!modPath) return this.cleanup(sorter, true)
		await getSize(modPath)
			.then((size) => sorter.setModSize(size))
			.catch(() => {})

		await scanForFiles(sorter, modPath)

		return this.cleanup(sorter, true)
	}

	async downloadAndUnpack(mod: Release, sorter: AuditReportBuilder): Promise<boolean> {
		const data = await this.portal.downloadRelease(mod).catch((err: Error) => {
			if (err.message === "File is malicious")
				sorter.addFinding({
					type: "MaliciousFile",
					description: `The mod's latest release (${mod.version}) was flagged as malicious by the virus scanner.`,
				})
			else sorter.addError(err)
			return null
		})
		if (!data) return false

		return await this.unpackAndScan(data, sorter)
	}
	async unpackAndScan(data: Buffer, sorter: AuditReportBuilder): Promise<boolean> {
		const tempPath = path.join("./cache/tmp", `${sorter.modName}-${sorter.version}/`)
		await fs.mkdir(tempPath, { recursive: true })
		const { entries } = await unzip(data)
		for (const [entryPath, entry] of Object.entries(entries)) {
			// Skip directories
			if (entry.isDirectory) continue

			if (path.resolve(entryPath).startsWith("..") || entryPath.startsWith("/")) {
				sorter.addFinding({
					type: "PathTraversal",
					description: `The mod contains a file with a potentially dangerous path.`,
					path: entryPath,
				})
				continue
			}
			const outputPath = path.join(tempPath, entryPath)

			// Create parent directories
			await fs.mkdir(path.dirname(outputPath), { recursive: true })

			// Write file data (as Buffer)
			const arrayBuffer = await entry.arrayBuffer()
			await fs.writeFile(outputPath, Buffer.from(arrayBuffer))
		}
		if (sorter.errors.length !== 0 || sorter.findings.length !== 0) return false
		const verdict = await scanFile(tempPath)
		if (verdict === Verdict.Malicious) {
			sorter.addFinding({
				type: "MaliciousFile",
				description: `The mod's latest release (${sorter.version}) was flagged as malicious by the virus scanner.`,
			})
			return false
		} else if (verdict === Verdict.ScanError) {
			sorter.addError(new Error("Error scanning mod files for malware"))
			return false
		}
		return true
	}
	async cleanup(sorter: AuditReportBuilder, save?: false): Promise<false>
	async cleanup(sorter: AuditReportBuilder, save: true): Promise<AuditReport>
	async cleanup(sorter: AuditReportBuilder, save = false): Promise<false | AuditReport> {
		const tempPath = path.join("./cache/tmp", `${sorter.modName}-${sorter.version}/`)
		await fs.rm(tempPath, { recursive: true, force: true })

		if (save) {
			const report = await sorter.saveReport()
			// update scanned index
			try {
				const dir = `./reports/${report.errors ? "errored" : report.findings ? "found" : "clean"}`
				const reportPath = `${dir}/${report.modName}-${report.version}.json`
				this.scannedIndex[report.sha1] = { reportPath, scannedAt: new Date().toISOString() }
				await this.saveIndex()
			} catch (err) {
				console.log("Failed to update scanned index:", err)
			}
			return report
		}
		return false
	}
}

export default Scanner
