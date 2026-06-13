import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"

export type FileEntry = {
	relativePath: string
	absolutePath: string
	isDirectory: false
	/** Lazily reads the full file content. No-op until called. */
	read: () => Promise<Buffer>
	size: () => Promise<number>
	unread: () => void
}

export type DirectoryEntry = {
	relativePath: string
	absolutePath: string
	isDirectory: true
	size: () => Promise<number>
}

export type PathEntry = FileEntry | DirectoryEntry

function getFolderSize(folderPath: string): Promise<number> {
	return readdir(folderPath, { withFileTypes: true, recursive: true }).then((entries) => {
		return Promise.all(
			entries.map((entry) => {
				if (!entry.isFile()) return 0
				const entryPath = path.join(folderPath, entry.name)
				return stat(entryPath)
					.then((s) => s.size)
					.catch(() => 0)
			}),
		)
			.then((sizes) => sizes.reduce((a, b) => a + b, 0))
			.catch(() => 0)
	})
}

export async function* walkDir(
	basePath: string,
	currentPath: string = ".",
): AsyncGenerator<PathEntry, any, boolean | void> {
	const pathToScan = path.join(basePath, currentPath)
	const entries = await readdir(pathToScan, { withFileTypes: true }).catch(() => [])

	for (const entry of entries) {
		const entryPath = path.join(pathToScan, entry.name)
		const relativePath = path.relative(basePath, entryPath)

		if (entry.isDirectory()) {
			let size: number | null = null
			const result = yield {
				relativePath,
				absolutePath: entryPath,
				isDirectory: true,
				size: async () => {
					if (size !== null) return size
					size = await getFolderSize(entryPath)
					return size
				},
			}
			if (result === true) continue
			yield* walkDir(basePath, relativePath)
			continue
		}
		if (!entry.isFile()) continue

		let size: number | null = null
		let content: Buffer | null = null

		yield {
			relativePath,
			absolutePath: entryPath,
			isDirectory: false,
			read: async () => {
				if (content) return content
				content = await readFile(entryPath)
				if (!size) size = content.length
				return content
			},
			size: async () => {
				if (size !== null) return size
				size = await stat(entryPath)
					.then((s) => s.size)
					.catch(() => 0)
				return size
			},
			unread: () => {
				content = null
			},
		}
	}
}

export default walkDir
