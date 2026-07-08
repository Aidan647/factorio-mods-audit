import type { Finding, ReportBuilder } from "../report"
import type { DirectoryEntry, FileEntry, PathEntry } from "./walkDir"

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

export interface Scanner {
	readonly id: string
	readonly weight: number
	readonly findings: Finding[]

	scan?(modPath: string, sorter: ReportBuilder): Promise<void>

	report(modPath: string, sorter: ReportBuilder): ScannerResult

	/**
	 * return true to skip scanning this directory or files inside it. Only applicable to scanners that need to skip entire directories (like clutter).
	 */
	scanFile?(modPath: string, sorter: ReportBuilder, entry: PathEntry): Promise<boolean | void>
}

export interface ScannerFactory {
	new (): Scanner
	loaded: boolean
	load?(): Promise<void>
}
// export abstract class Scanner {
// 	abstract readonly id: string
// 	abstract readonly weight: number
// 	abstract readonly findings: Finding[]

// 	abstract scan?(modPath: string, sorter: ReportBuilder): Promise<void> | void

// 	abstract report(modPath: string, sorter: ReportBuilder): ScannerResult

// 	abstract fileScans?(
// 		modPath: string,
// 		sorter: ReportBuilder,
// 		generator: AsyncGenerator<FileEntry>,
// 	): Promise<void> | void
// }
