import { mkdir, readdir, rename, rmdir, stat, unlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

/** Metadata stored alongside each cached entry */
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
	 * Creates cache directory and repopulates index from existing .meta files.
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
		// Ensure cache directory exists
		await mkdir(this.cacheDir, { recursive: true })

		if (this.skipCacheLoading) return

		// Recursively find all .meta files. In recursive mode, entries are
		// relative paths like "ab/cd/{key}.meta"
		const files: string[] = await readdir(this.cacheDir, { recursive: true }).catch(() => [])

		// Delete any .meta.tmp files (incomplete writes)
		const tmpFiles = files.filter((f) => f.endsWith(".meta.tmp"))
		await Promise.all(tmpFiles.map((f) => unlink(join(this.cacheDir, f)).catch(() => {})))

		// Repopulate index from .meta files
		const metaFiles = files.filter((f) => f.endsWith(".meta"))
		const metaReads = metaFiles.map(async (f) => {
			const key = basename(f).slice(0, -".meta".length)
			const metaPath = join(this.cacheDir, f)
			const dataPath = join(dirname(metaPath), `${key}${this.extension}`)

			// Check if data file exists
			const dataExists = await stat(dataPath)
				.then(() => true)
				.catch(() => false)
			if (!dataExists) {
				// Data file missing, delete orphaned meta
				await unlink(metaPath).catch(() => {})
				return null
			}

			// Read and parse meta
			const metaContent = await Bun.file(metaPath)
				.text()
				.catch(() => null)
			if (!metaContent) return null

			const meta = JSON.parse(metaContent) as DiskCacheMeta
			return { key, meta }
		})

		const results = await Promise.allSettled(metaReads)
		for (const result of results) {
			if (result.status === "fulfilled" && result.value) {
				const { key, meta } = result.value
				this.index.set(key, {
					timestamp: meta.timestamp,
					hash: meta.hash,
				})
			}
		}
	}

	private dataPath(key: string): string {
		return join(this.entryDir(key), `${key}${this.extension}`)
	}

	private metaPath(key: string): string {
		return join(this.entryDir(key), `${key}.meta`)
	}

	private metaTmpPath(key: string): string {
		return join(this.entryDir(key), `${key}.meta.tmp`)
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
	 * Store a value in the cache with optional etag.
	 * Uses atomic write (.meta.tmp → .meta rename).
	 * On failure, attempts to clean up and swallows error.
	 */
	async set(key: string, data: T): Promise<void> {
		const dataPath = this.dataPath(key)
		const metaPath = this.metaPath(key)
		const metaTmpPath = this.metaTmpPath(key)

		const serialized = await this.serialize(data)
		const hash = this.computeHash(serialized)
		const timestamp = Date.now()

		const meta: DiskCacheMeta = {
			timestamp,
			hash,
		}

		try {
			// Ensure entry directory exists
			await mkdir(this.entryDir(key), { recursive: true })

			// 1. Write data file
			await Bun.write(dataPath, serialized)

			// 2. Write meta to temp file
			await Bun.write(metaTmpPath, JSON.stringify(meta))

			// 3. Atomic rename
			await rename(metaTmpPath, metaPath)

			// 4. Update index
			this.index.set(key, { timestamp, hash })
		} catch {
			// Clean up on failure
			await unlink(dataPath).catch(() => {})
			await unlink(metaTmpPath).catch(() => {})
			await unlink(metaPath).catch(() => {})
			this.index.delete(key)
		}
	}

	/**
	 * Check if a key exists in the cache (not expired).
	 */
	has(key: string): boolean {
		const entry = this.index.get(key)
		if (!entry) return false
		return Date.now() - entry.timestamp < this.expiryMs
	}

	/**
	 * Delete a cache entry.
	 */
	async delete(key: string): Promise<boolean> {
		if (!this.index.has(key)) return false
		await this.deleteEntry(key)
		return true
	}

	private async deleteEntry(key: string): Promise<void> {
		this.index.delete(key)
		await unlink(this.dataPath(key)).catch(() => {})
		await unlink(this.metaPath(key)).catch(() => {})
		await this.cleanupEmptyDirs(key)
	}

	/**
	 * Remove empty ancestor directories after deleting an entry.
	 * Walks from leaf to root, stopping at the first non-empty directory.
	 */
	private async cleanupEmptyDirs(key: string): Promise<void> {
		const parts = this.folderParts(key)
		if (parts.length === 0) return

		for (let depth = parts.length; depth > 0; depth--) {
			const dir = join(this.cacheDir, ...parts.slice(0, depth))
			const contents = await readdir(dir).catch(() => null)
			if (contents && contents.length === 0) {
				await rmdir(dir).catch(() => {})
			} else {
				break
			}
		}
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

		const timestamp = Date.now()
		entry.timestamp = timestamp

		// Update meta file atomically
		const meta: DiskCacheMeta = {
			timestamp,
			hash: entry.hash,
		}

		const metaPath = this.metaPath(key)
		const metaTmpPath = this.metaTmpPath(key)

		await Bun.write(metaTmpPath, JSON.stringify(meta))
			.then(() => rename(metaTmpPath, metaPath))
			.catch(() => unlink(metaTmpPath).catch(() => {}))
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

		await Promise.all(keysToDelete.map((key) => this.deleteEntry(key)))
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
