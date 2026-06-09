import { readdir, stat } from "node:fs/promises"
import path from "node:path"

export async function getFolderRecursively(basePath: string) {
	const results: string[] = []
	await collectFiles(basePath, results)
	return results
}

async function collectFiles(currentPath: string, results: string[]) {
	const entries = await readdir(currentPath, { withFileTypes: true })
	for (const entry of entries) {
		const entryPath = path.join(currentPath, entry.name)
		if (entry.isDirectory()) {
			await collectFiles(entryPath, results)
			continue
		}
		results.push(entryPath)
	}
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
		const files = await getFolderRecursively(filePath)
		for (const file of files) {
			const fileStats = await stat(file)
			totalSize += fileStats.size
		}
		return totalSize
	}
	return -1
}
