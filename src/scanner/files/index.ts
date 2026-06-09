import type { AuditSorter } from "#/findingsSorter"
import { findClutterFiles } from "./developingFiles"



export async function scanForFiles(sorter: AuditSorter, basePath: string) {
	await findClutterFiles(sorter, basePath)
}
