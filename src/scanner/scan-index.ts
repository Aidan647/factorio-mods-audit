import fs from "fs/promises"
import path from "node:path"

export type IndexEntry = {
	reportPath: string
	scannedAt: string
}

export class ScanIndex {
	private data: Record<string, IndexEntry> = {}

	constructor(private readonly indexPath: string = "./cache/scanned.json") {}

	async load(): Promise<this> {
		await fs
			.readFile(this.indexPath, "utf-8")
			.then((raw) => {
				this.data = JSON.parse(raw)
				console.log(`Loaded scanned index with ${Object.keys(this.data).length} entries`)
			})
			.catch((err: NodeJS.ErrnoException) => {
				if (err.code === "ENOENT") this.data = {}
				else console.log("Error loading scanned index:", err)
			})
		return this
	}

	has(sha1: string): boolean {
		return sha1 in this.data
	}

	set(sha1: string, entry: IndexEntry): void {
		this.data[sha1] = entry
	}

	async save(): Promise<void> {
		await fs.mkdir(path.dirname(this.indexPath), { recursive: true })
		await fs.writeFile(this.indexPath, JSON.stringify(this.data, null, 2))
	}
}
