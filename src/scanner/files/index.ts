import type { AuditSorter } from "#/findingsSorter"
import { findDevelopingFiles } from "./developingFiles"



export async function scanForFiles(sorter: AuditSorter, basePath: string) {
	await findDevelopingFiles(sorter, basePath)
}
