import { mkdir } from "fs/promises"
import type { ModInfo, ModListItem, Release } from "../modportal/types"
import { JSON5 } from "bun"

export type Finding = {
	type: string
	description: string
	severity?: "low" | "medium" | "high"

	/**
	 * potential saving in bytes if this finding is fixed.
	 */
	potentialSavings?: number
} & (
	| {
			path: string
	  }
	| {
			paths: string[]
	  }
	| {}
)
export type AuditReport = {
	modName: string
	version: string
	sha1: string
	timestamp: number
	potentialSavings?: number
	modSize?: number
	percentageSavings?: number
	findings?: Finding[]
	errors?: string[]
}

export class AuditReportBuilder {
	readonly findings: Finding[] = []
	readonly errors: Error[] = []
	potentialSavings = 0
	modSize = 0
	readonly modName: string
	readonly version: string
	readonly sha1: string

	constructor(modInfo: ModListItem, release?: Release) {
		this.modName = modInfo.name
		this.version = release?.version ?? modInfo.latest_release?.version ?? "unknown"
		this.sha1 = release?.sha1 ?? modInfo.latest_release?.sha1 ?? "unknown"
	}

	addFinding(finding: Finding): this {
		this.findings.push(finding)
		if (finding.potentialSavings && finding.potentialSavings > 0) this.potentialSavings += finding.potentialSavings
		return this
	}
	addError(error: Error): this {
		this.errors.push(error)
		return this
	}

	setModSize(size: number): this {
		this.modSize = size
		return this
	}

	async saveReport(): Promise<AuditReport> {
		// save report to ./reports/errored or ./reports/found depending on if there are findings or errors
		// if no findings or errors, save to ./reports/clean
		const report: AuditReport = {
			modName: this.modName,
			version: this.version,
			sha1: this.sha1,
			timestamp: Date.now(),
		}
		if (this.modSize > 0) report.modSize = this.modSize
		if (this.potentialSavings > 0) report.potentialSavings = this.potentialSavings
		if (this.modSize > 0 && this.potentialSavings > 0)
			report.percentageSavings = (this.potentialSavings / this.modSize) * 100
		if (this.findings.length > 0) report.findings = this.findings
		if (this.errors.length > 0) report.errors = this.errors.map((e) => e.message)
		const dir = `./reports/${report.errors ? "errored" : report.findings ? "found" : "clean"}`
		await mkdir(dir, { recursive: true })
		await Bun.write(`${dir}/${this.modName}-${this.version}.json`, JSON.stringify(report, null, "\t") ?? "")
		return report
	}
}
