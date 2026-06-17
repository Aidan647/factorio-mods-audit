import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

export interface DiskCacheMeta {
	timestamp: number
	hash: string // wyhash hex
}

export interface DiskCacheOptions<T> {
	/** Directory to store cache files */
	cacheDir: string
	/** File extension for data files (e.g., ".png", ".json") */
	extension: string
	/** Cache expiry in milliseconds */
	expiryMs: number
	/** Serialize data to Buffer/string for disk. Default: identity (assumes T is Buffer | string) */
	serialize?: (data: T) => Buffer | string | Promise<Buffer | string>
	/** Deserialize Buffer from disk to T. return undefined if invalid */
	deserialize?: (raw: Buffer) => T | undefined | Promise<T | undefined>
	/** Verify hash on read. Default: true */
	verifyOnRead?: boolean
	/** Number of hex chars per nesting level for subdirectory splitting. E.g. [2,2] → ab/cd/{key}.ext */
	splitFolders?: number[]
	/** Skip loading existing cache entries from disk on init. Default: false */
	skipCacheLoading?: boolean
	/** Auto-prune interval in milliseconds. If set, starts prune scheduler */
	pruneIntervalMs?: number
}

interface IndexEntry {
	timestamp: number
	hash: string
}

/**
 * Disk-based cache with atomic writes, hash verification, and etag support.
 * Use `DiskCache.create()` to instantiate.
 */
export class DiskCache<T> {
	private readonly index = new Map<string, IndexEntry>()
	private pruneTimer: ReturnType<typeof setInterval> | null = null
	private indexLoaded = false

	private readonly cacheDir: string
	private readonly extension: string
	private readonly expiryMs: number
	private readonly splitFolders: number[]
	private readonly skipCacheLoading: boolean
	private readonly serialize: (data: T) => Buffer | string | Promise<Buffer | string>
	private readonly deserialize: (raw: Buffer) => T | undefined | Promise<T | undefined>
	private readonly verifyOnRead: boolean

	private constructor(
		options: Required<Omit<DiskCacheOptions<T>, "pruneIntervalMs">> & { pruneIntervalMs?: number },
	) {
		this.cacheDir = options.cacheDir
		this.extension = options.extension
		this.expiryMs = options.expiryMs
		this.splitFolders = options.splitFolders
		this.skipCacheLoading = options.skipCacheLoading
		this.serialize = options.serialize
		this.deserialize = options.deserialize
		this.verifyOnRead = options.verifyOnRead

		if (options.pruneIntervalMs) {
			this.pruneTimer = setInterval(() => this.prune(), options.pruneIntervalMs)
		}
	}

	/**
	 * Create and initialize a DiskCache instance.
	 * Creates cache directory and loads index file.
	 */
	static async create<T>(options: DiskCacheOptions<T>): Promise<DiskCache<T>> {
		const opts = {
			...options,
			serialize: options.serialize ?? ((data: T) => data as Buffer | string),
			deserialize: options.deserialize ?? ((raw: Buffer) => raw as T),
			verifyOnRead: options.verifyOnRead ?? true,
			splitFolders: options.splitFolders ?? [],
			skipCacheLoading: options.skipCacheLoading ?? false,
		}

		const instance = new DiskCache<T>(opts)
		await instance.init()
		return instance
	}

	private async init(): Promise<void> {
		await mkdir(this.cacheDir, { recursive: true })
		if (this.skipCacheLoading) return

		// Load the consolidated index file — one read instead of N .meta files
		await this.loadIndex().catch(() => {})
	}

	private indexFilePath(): string {
		return join(this.cacheDir, "index.meta")
	}

	/**
	 * Read the consolidated index.meta file into memory.
	 * On first run (no index.meta), attempts one-time migration from old per-entry .meta files.
	 */
	private async loadIndex(): Promise<void> {
		if (this.indexLoaded) return

		const indexPath = this.indexFilePath()
		const content = await Bun.file(indexPath)
			.text()
			.catch(() => null)

		if (content) {
			const parsed = JSON.parse(content) as Record<string, IndexEntry>
			for (const [key, entry] of Object.entries(parsed)) {
				this.index.set(key, entry)
			}
			this.indexLoaded = true
			// Clean up any leftover .meta.tmp files
			await unlink(indexPath + ".tmp").catch(() => {})
			return
		}

		// One-time migration: look for old per-entry .meta files
		const allFiles = await readdir(this.cacheDir, { recursive: true }).catch(() => [])
		const metaFiles = allFiles.filter((f) => f.endsWith(".meta") && !f.endsWith(".meta.tmp"))

		if (metaFiles.length === 0) {
			this.indexLoaded = true
			return
		}

		let migrated = 0
		for (const f of metaFiles) {
			const key = basename(f).slice(0, -".meta".length)
			const metaPath = join(this.cacheDir, f)
			const dataPath = join(dirname(metaPath), `${key}${this.extension}`)

			const dataExists = await stat(dataPath).then(() => true).catch(() => false)
			if (!dataExists) {
				await unlink(metaPath).catch(() => {})
				continue
			}

			const metaContent = await Bun.file(metaPath).text().catch(() => null)
			if (!metaContent) {
				await unlink(metaPath).catch(() => {})
				continue
			}

			const meta = JSON.parse(metaContent) as { timestamp: number; hash: string }
			this.index.set(key, { timestamp: meta.timestamp, hash: meta.hash })
			await unlink(metaPath).catch(() => {})
			migrated++
		}

		if (migrated > 0) {
			console.log(`DiskCache: migrated ${migrated} entries from .meta files to index.meta`)
			await this.saveIndex()
		}

		this.indexLoaded = true
	}

	/**
	 * Atomically write the in-memory index to index.meta.
	 */
	private async saveIndex(): Promise<void> {
		const indexPath = this.indexFilePath()
		const tmpPath = indexPath + ".tmp"

		const obj: Record<string, IndexEntry> = {}
		for (const [key, entry] of this.index) {
			obj[key] = entry
		}

		await Bun.write(tmpPath, JSON.stringify(obj))
		await rename(tmpPath, indexPath)
	}

	private dataPath(key: string): string {
		return join(this.entryDir(key), `${key}${this.extension}`)
	}

	private computeHash(data: Buffer | string): string {
		return Bun.hash(data).toString(16)
	}

	/**
	 * Compute subdirectory path parts from the key hash.
	 * Each element of splitFolders consumes that many hex chars.
	 * E.g. [2, 2] with hash "c2939582..." → ["c2", "93"]
	 */
	private folderParts(key: string): string[] {
		if (this.splitFolders.length === 0) return []
		const hashHex = Bun.hash(key).toString(16)
		const parts: string[] = []
		let offset = 0
		for (const len of this.splitFolders) {
			parts.push(hashHex.slice(offset, offset + len))
			offset += len
		}
		return parts
	}

	/**
	 * Get the directory path for a given key, creating subdirectories as configured.
	 */
	private entryDir(key: string): string {
		const parts = this.folderParts(key)
		return parts.length > 0 ? join(this.cacheDir, ...parts) : this.cacheDir
	}

	/**
	 * Get a cached value by key. Returns undefined if not found, expired, or corrupted.
	 */
	async get(key: string): Promise<T | undefined> {
		await this.loadIndex()
		const entry = this.index.get(key)
		if (!entry) return undefined

		// Check expiry
		const now = Date.now()
		if (now - entry.timestamp >= this.expiryMs) {
			return undefined // Expired but not deleted (prune handles deletion)
		}

		// Read data file
		const dataPath = this.dataPath(key)
		const file = Bun.file(dataPath)
		const exists = await file.exists()
		if (!exists) {
			// Data file missing, clean up
			await this.deleteEntry(key)
			return undefined
		}

		const raw = Buffer.from(await file.arrayBuffer())

		// Verify hash if enabled
		if (this.verifyOnRead) {
			const computedHash = this.computeHash(raw)
			if (computedHash !== entry.hash) {
				// Hash mismatch, corrupted data
				console.warn(`DiskCache: hash mismatch for key "${key}", deleting corrupted entry`)
				await this.deleteEntry(key)
				return undefined
			}
		}
		const deserialized = await this.deserialize(raw)
		if (deserialized === undefined) {
			// Deserialization failed, treat as corrupted
			await this.deleteEntry(key)
			return undefined
		}
		return deserialized satisfies T
	}

	/**
	 * Store a value in the cache.
	 * On failure, attempts to clean up and swallows error.
	 */
	async set(key: string, data: T): Promise<void> {
		const dataPath = this.dataPath(key)

		const serialized = await this.serialize(data)
		const hash = this.computeHash(serialized)
		const timestamp = Date.now()

		try {
			await mkdir(this.entryDir(key), { recursive: true })
			await Bun.write(dataPath, serialized)

			this.index.set(key, { timestamp, hash })
			await this.saveIndex()
		} catch {
			await unlink(dataPath).catch(() => {})
			this.index.delete(key)
		}
	}

	/**
	 * Check if a key exists in the cache (not expired).
	 */
	has(key: string): boolean {
		if (!this.indexLoaded) this.loadIndex().catch(() => {})
		const entry = this.index.get(key)
		if (!entry) return false
		return Date.now() - entry.timestamp < this.expiryMs
	}

	/**
	 * Delete a cache entry.
	 */
	async delete(key: string): Promise<boolean> {
		await this.loadIndex()
		if (!this.index.has(key)) return false
		await this.deleteEntry(key)
		return true
	}

	private async deleteEntry(key: string): Promise<void> {
		this.index.delete(key)
		await unlink(this.dataPath(key)).catch(() => {})
		await this.saveIndex()
	}

	/**
	 * Get the timestamp for a cached entry.
	 */
	getTimestamp(key: string): number | undefined {
		if (!this.indexLoaded) this.loadIndex().catch(() => {})
		return this.index.get(key)?.timestamp
	}

	/**
	 * Update timestamp without rewriting data (e.g., on 304 response).
	 */
	async touch(key: string): Promise<void> {
		await this.loadIndex()
		const entry = this.index.get(key)
		if (!entry) return

		entry.timestamp = Date.now()
		await this.saveIndex()
	}

	/**
	 * Remove expired entries. If maxAgeMs provided, uses that instead of expiryMs.
	 * Returns number of entries pruned.
	 */
	async prune(maxAgeMs?: number): Promise<number> {
		await this.loadIndex()
		const threshold = maxAgeMs ?? this.expiryMs
		const now = Date.now()
		const keysToDelete: string[] = []

		for (const [key, entry] of this.index) {
			if (now - entry.timestamp >= threshold) {
				keysToDelete.push(key)
			}
		}

		await Promise.all(keysToDelete.map((key) => this.deleteEntry(key)))
		return keysToDelete.length
	}

	/**
	 * Get all cache keys.
	 */
	keys(): IterableIterator<string> {
		if (!this.indexLoaded) this.loadIndex().catch(() => {})
		return this.index.keys()
	}

	/**
	 * Get all cache entries (key → metadata).
	 */
	entries(): IterableIterator<[string, IndexEntry]> {
		if (!this.indexLoaded) this.loadIndex().catch(() => {})
		return this.index.entries()
	}

	/**
	 * Get number of entries in cache.
	 */
	size(): number {
		if (!this.indexLoaded) this.loadIndex().catch(() => {})
		return this.index.size
	}

	/**
	 * Stop prune scheduler and clean up resources.
	 */
	destroy(): void {
		if (this.pruneTimer) {
			clearInterval(this.pruneTimer)
			this.pruneTimer = null
		}
	}
}

export default DiskCache
