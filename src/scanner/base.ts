import type { Finding, ReportBuilder } from "../report"

export type ScannerResult = {
	/** Scanner identifier */
	id: string
	/** 0-100, penalty-based score for this scanner */
	score: number
	/** Weight for final score aggregation */
	weight: number
	/** Potential savings in bytes */
	savings: number
	/** Findings discovered by this scanner */
	findings: Finding[]
}

export abstract class Scanner {
	abstract readonly id: string
	abstract readonly weight: number

	abstract scan(modPath: string, sorter: ReportBuilder): Promise<ScannerResult>
}
