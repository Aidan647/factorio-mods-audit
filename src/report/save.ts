import { mkdir } from "fs/promises"
import type { AuditReport } from "."
import { defaultConfig } from "../config"

export async function saveReportToDisk(
	report: AuditReport,
	reportsDir: string = defaultConfig.reportsDir,
): Promise<void> {
	const dir =
		report.errors && report.errors.length > 0
			? `${reportsDir}/errored`
			: report.score < 100
				? `${reportsDir}/found`
				: `${reportsDir}/clean`
	await mkdir(dir, { recursive: true })
	await Bun.write(`${dir}/${report.modName}-${report.version}.json`, JSON.stringify(report, null, "\t") ?? "")
}
