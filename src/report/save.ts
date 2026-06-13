import { mkdir } from "fs/promises"
import type { AuditReport } from "."
import { join, dirname } from "path"

export async function saveReportToDisk(report: AuditReport, reportsDir: string): Promise<string> {
	const scoreDir = report.errors && report.errors.length > 0 ? "errored" : report.score < 100 ? "found" : "clean"
	const path = join(reportsDir, scoreDir, `${report.modName}-${report.version}.json`)

	await mkdir(dirname(path), { recursive: true })
	await Bun.write(path, JSON.stringify(report))

	return path
}
