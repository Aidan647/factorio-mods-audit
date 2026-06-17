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
	private saveChain: Promise<void> | null = null
	private saveQueued = false

	private readonly cacheDir: string
	private readonly indexFilePath: string
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

		this.indexFilePath = join(this.cacheDir, "index.meta")

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
		// Load index eagerly — one read instead of N .meta files
		await this.loadIndex()
	}

	/**
	 * Read the consolidated index.meta file into memory.
	 * On first run (no index.meta), attempts one-time migration from old per-entry .meta files.
	 */
	private async loadIndex(): Promise<void> {
		if (this.skipCacheLoading) return

		const content = await Bun.file(this.indexFilePath)
			.text()
			.catch(() => null)

		if (content) {
			const parsed = JSON.parse(content) as Record<string, IndexEntry>
			for (const [key, entry] of Object.entries(parsed)) {
				this.index.set(key, entry)
			}
			// Clean up any leftover .meta.tmp files
			await unlink(this.indexFilePath + ".tmp").catch(() => {})

			// also scan for any files in the cache dir that aren't in the index and remove them
			const allFiles = await readdir(this.cacheDir, { recursive: true }).catch(() => [])
			for (const f of allFiles) {
				if (f.endsWith(".meta") || f.endsWith(".meta.tmp")) {
					if (f === "index.meta") continue
					await unlink(join(this.cacheDir, f)).catch(() => {})
					continue
				}
				if (!f.endsWith(this.extension)) continue
				const key = basename(f, this.extension)

				if (!this.index.has(key)) {
					await unlink(join(this.cacheDir, f)).catch(() => {})
				}
			}
			return
		}
	}

	/**
	 * Queue an atomic write of the in-memory index to index.meta.
	 * Calls are serialized via the saveChain promise to prevent races.
	 */
	private saveIndex(): void {
		if (!this.saveChain) {
			// Idle → start write now
			this.saveChain = this.writeIndex().catch((err) => {
				console.error("DiskCache: failed to save index:", err)
			})
		} else if (!this.saveQueued) {
			// Write in progress, no follow-up yet → schedule one
			this.saveQueued = true
		}
	}
	get saveAwaiter(): Promise<void> {
		return this.saveChain ?? Promise.resolve()
	}
	private async writeIndex(): Promise<void> {
		await Bun.sleep(50) // Artificial delay to batch multiple rapid updates
		this.saveQueued = false // safe because the data snapshot is captured below

		const obj: Record<string, IndexEntry> = {}
		for (const [key, entry] of this.index) {
			obj[key] = entry
		}

		const tmpPath = this.indexFilePath + ".tmp"
		await Bun.write(tmpPath, JSON.stringify(obj))
		await rename(tmpPath, this.indexFilePath)

		this.saveChain = null
		if (this.saveQueued) {
			this.saveQueued = false
			this.saveIndex() // triggers the next write
		}
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
	 * E.g. [2, 2] with key "c2939582..." → ["c2", "93"]
	 */
	private folderParts(key: string): string[] {
		if (this.splitFolders.length === 0) return []
		const parts: string[] = []
		let index = 0
		for (const length of this.splitFolders) {
			if (index + length > key.length) break
			parts.push(key.slice(index, index + length))
			index += length
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
			this.deleteEntry(key)
			return undefined
		}

		const raw = Buffer.from(await file.arrayBuffer())

		// Verify hash if enabled
		if (this.verifyOnRead) {
			const computedHash = this.computeHash(raw)
			if (computedHash !== entry.hash) {
				// Hash mismatch, corrupted data
				console.warn(`DiskCache: hash mismatch for key "${key}", deleting corrupted entry`)
				this.deleteEntry(key)
				return undefined
			}
		}
		const deserialized = await this.deserialize(raw)
		if (deserialized === undefined) {
			// Deserialization failed, treat as corrupted
			this.deleteEntry(key)
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
		} catch {
			await unlink(dataPath).catch(() => {})
			this.index.delete(key)
		}
		this.saveIndex()
	}

	/**
	 * Check if a key exists in the cache (not expired).
	 */
	has(key: string): boolean {
		const entry = this.index.get(key)
		if (!entry) return false

		if (Date.now() - entry.timestamp >= this.expiryMs) {
			return false
		}
		return true
	}

	/**
	 * Delete a cache entry.
	 */
	delete(key: string): boolean {
		if (!this.index.has(key)) return false
		this.deleteEntry(key)
		return true
	}

	private deleteEntry(key: string): void {
		const removed = this.index.delete(key)
		if (!removed) return
		this.saveIndex()
		unlink(this.dataPath(key)).catch(() => {})
	}

	/**
	 * Get the timestamp for a cached entry.
	 */
	getTimestamp(key: string): number | undefined {
		return this.index.get(key)?.timestamp
	}

	/**
	 * Update timestamp without rewriting data (e.g., on 304 response).
	 */
	async touch(key: string): Promise<void> {
		const entry = this.index.get(key)
		if (!entry) return

		entry.timestamp = Date.now()
		this.saveIndex()
	}

	/**
	 * Remove expired entries. If maxAgeMs provided, uses that instead of expiryMs.
	 * Returns number of entries pruned.
	 */
	async prune(maxAgeMs?: number): Promise<number> {
		const threshold = maxAgeMs ?? this.expiryMs
		const now = Date.now()
		const keysToDelete: string[] = []

		for (const [key, entry] of this.index) {
			if (now - entry.timestamp >= threshold) {
				keysToDelete.push(key)
			}
		}

		for (const key of keysToDelete) {
			this.deleteEntry(key)
		}
		return keysToDelete.length
	}

	/**
	 * Get all cache keys.
	 */
	keys(): IterableIterator<string> {
		return this.index.keys()
	}

	/**
	 * Get all cache entries (key → metadata).
	 */
	entries(): IterableIterator<[string, IndexEntry]> {
		return this.index.entries()
	}

	/**
	 * Get number of entries in cache.
	 */
	size(): number {
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
