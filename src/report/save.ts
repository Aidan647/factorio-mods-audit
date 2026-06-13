import { mkdir } from "fs/promises"
import type { AuditReport } from "."
import { defaultConfig } from "../config"
import { formatTxt, formatMd, formatHtml } from "./formatters"
import path from "path"

export async function saveReportToDisk(
	report: AuditReport,
	reportsDir: string = defaultConfig.reportsDir,
): Promise<void> {
	const scoreDir = report.errors && report.errors.length > 0 ? "errored" : report.score < 100 ? "found" : "clean"

	const promises = []

	// JSON
	promises.push(
		mkdir(`${reportsDir}/${scoreDir}`, { recursive: true }).then(() =>
			Bun.write(
				path.join(reportsDir, scoreDir, `${report.modName}-${report.version}.json`),
				JSON.stringify(report, null, "\t") ?? "",
			),
		),
	)

	// TXT
	promises.push(
		mkdir(`${reportsDir}/txt`, { recursive: true }).then(() =>
			Bun.write(path.join(reportsDir, "txt", `${report.modName}-${report.version}.txt`), formatTxt(report)),
		),
	)

	// MD
	promises.push(
		mkdir(`${reportsDir}/md`, { recursive: true }).then(() =>
			Bun.write(path.join(reportsDir, "md", `${report.modName}-${report.version}.md`), formatMd(report)),
		),
	)

	// HTML
	promises.push(
		mkdir(`${reportsDir}/html`, { recursive: true }).then(() =>
			Bun.write(path.join(reportsDir, "html", `${report.modName}-${report.version}.html`), formatHtml(report)),
		),
	)

	await Promise.all(promises)
}
