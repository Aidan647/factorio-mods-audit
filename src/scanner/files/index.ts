import type { AuditReportBuilder } from "#/findingsSorter"
import { findClutterFiles } from "./developingFiles"

export async function scanForFiles(sorter: AuditReportBuilder, basePath: string) {
	await findClutterFiles(sorter, basePath)
}
