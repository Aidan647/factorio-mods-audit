import type { ModListItem, Release } from "../modportal/types"
import type { ScannerResult } from "../scanner/base"
import { saveReportToDisk } from "./save"
import { calculateScore } from "./score"

export type Finding = {
	type: string
	description: string
	severity?: "low" | "medium" | "high"

	/**
	 * potential saving in bytes if this finding is fixed.
	 */
	potentialSavings?: number

	/** Paths related to this finding, if any. */
	paths?: string[]
}

export type ScannerReport = {
	id: string
	score: number
	weight: number
	savings: number
	findings: Finding[]
}

export type AuditReport = {
	modName: string
	modNameReadable: string
	version: string
	sha1: string
	timestamp: number
	modSize?: number
	score: number
	potentialSavings?: number
	percentageSavings?: number
	scanners: ScannerReport[]
	preflightFindings?: Finding[]
	errors?: string[]
}

export class ReportBuilder {
	readonly errors: Error[] = []
	readonly preflightFindings: Finding[] = []
	readonly scannerResults: ScannerResult[] = []
	modSize = 0
	readonly modName: string
	readonly modNameReadable: string
	readonly version: string
	readonly sha1: string

	constructor(
		modInfo: ModListItem,
		release?: Release,
		private readonly reportsDir: string = "./reports",
	) {
		this.modName = modInfo.name
		this.modNameReadable = modInfo.title
		this.version = release?.version ?? modInfo.latest_release?.version ?? "unknown"
		this.sha1 = release?.sha1 ?? modInfo.latest_release?.sha1 ?? "unknown"
	}

	addPreflightFinding(finding: Finding): this {
		this.preflightFindings.push(finding)
		return this
	}

	addError(error: Error): this {
		this.errors.push(error)
		return this
	}

	addScannerResult(result: ScannerResult): this {
		if (result.score === 100) return this
		this.scannerResults.push(result)
		return this
	}

	setModSize(size: number): this {
		this.modSize = size
		return this
	}

	get totalSavings(): number {
		return this.scannerResults.reduce((sum, r) => sum + r.savings, 0)
	}

	get finalScore(): number {
		return calculateScore(this.scannerResults)
	}

	async saveReport(): Promise<AuditReport> {
		const scanners: ScannerReport[] = this.scannerResults.map((r) => ({
			id: r.id,
			score: r.score,
			weight: r.weight,
			savings: r.savings,
			findings: r.findings,
		}))

		const report: AuditReport = {
			modName: this.modName,
			modNameReadable: this.modNameReadable,
			version: this.version,
			sha1: this.sha1,
			timestamp: Date.now(),
			score: this.finalScore,
			scanners,
		}
		if (this.modSize > 0) report.modSize = this.modSize
		const savings = this.totalSavings
		if (savings > 0) report.potentialSavings = savings
		if (this.modSize > 0 && savings > 0)
			report.percentageSavings = Math.round((savings / this.modSize) * 10000) / 100
		if (this.preflightFindings.length > 0) report.preflightFindings = this.preflightFindings
		if (this.errors.length > 0) report.errors = this.errors.map((e) => e.message)

		await saveReportToDisk(report, this.reportsDir)
		return report
	}
}
