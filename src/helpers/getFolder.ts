import { readdir, stat } from "node:fs/promises"
import path from "node:path"

export async function getFolderRecursively(basePath: string) {
	const files = await readdir(basePath, { withFileTypes: true, recursive: true })
	const results: string[] = []
	for (const file of files) {
		if (file.isDirectory()) {
			continue
		}
		results.push(path.join(basePath, file.name))
	}
	return results
}
/**
 * get size of file or folder in bytes. For folders, get size of all files recursively.
 */
export async function getSize(filePath: string): Promise<number> {
	const stats = await stat(filePath)
	if (stats.isFile()) {
		return stats.size
	} else if (stats.isDirectory()) {
		let totalSize = 0
		const files = await readdir(filePath, { withFileTypes: true, recursive: true })
		for (const file of files) {
			if (file.isFile()) {
				const fileStats = await stat(path.join(filePath, file.name))
				totalSize += fileStats.size
			}
			return totalSize
		}
	}
	return -1
}
