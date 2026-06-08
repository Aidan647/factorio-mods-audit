import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises"
import { join } from "node:path"

/** Metadata stored alongside each cached entry */
export interface DiskCacheMeta {
	timestamp: number
	etag: string | null
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
	serialize?: (data: T) => Buffer | string
	/** Deserialize Buffer from disk to T. Default: identity (returns Buffer as T) */
	deserialize?: (raw: Buffer) => T
	/** Verify hash on read. Default: true */
	verifyOnRead?: boolean
	/** Auto-prune interval in milliseconds. If set, starts prune scheduler */
	pruneIntervalMs?: number
}

interface IndexEntry {
	timestamp: number
	etag: string | null
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
	private readonly serialize: (data: T) => Buffer | string
	private readonly deserialize: (raw: Buffer) => T
	private readonly verifyOnRead: boolean

	private constructor(
		options: Required<Omit<DiskCacheOptions<T>, "pruneIntervalMs">> & { pruneIntervalMs?: number },
	) {
		this.cacheDir = options.cacheDir
		this.extension = options.extension
		this.expiryMs = options.expiryMs
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
		}

		const instance = new DiskCache<T>(opts)
		await instance.init()
		return instance
	}

	private async init(): Promise<void> {
		// Ensure cache directory exists
		await mkdir(this.cacheDir, { recursive: true })

		// Read directory and process files
		const files = await readdir(this.cacheDir).catch(() => [])

		// Delete any .meta.tmp files (incomplete writes)
		const tmpFiles = files.filter((f) => f.endsWith(".meta.tmp"))
		await Promise.all(tmpFiles.map((f) => unlink(join(this.cacheDir, f)).catch(() => {})))

		// Repopulate index from .meta files
		const metaFiles = files.filter((f) => f.endsWith(".meta"))
		const metaReads = metaFiles.map(async (f) => {
			const key = f.slice(0, -".meta".length)
			const metaPath = join(this.cacheDir, f)
			const dataPath = join(this.cacheDir, `${key}${this.extension}`)

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
					etag: meta.etag,
					hash: meta.hash,
				})
			}
		}
	}

	private dataPath(key: string): string {
		return join(this.cacheDir, `${key}${this.extension}`)
	}

	private metaPath(key: string): string {
		return join(this.cacheDir, `${key}.meta`)
	}

	private metaTmpPath(key: string): string {
		return join(this.cacheDir, `${key}.meta.tmp`)
	}

	private computeHash(data: Buffer | string): string {
		return Bun.hash(data).toString(16)
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

		return this.deserialize(raw)
	}

	/**
	 * Store a value in the cache with optional etag.
	 * Uses atomic write (.meta.tmp → .meta rename).
	 * On failure, attempts to clean up and swallows error.
	 */
	async set(key: string, data: T, etag?: string): Promise<void> {
		const dataPath = this.dataPath(key)
		const metaPath = this.metaPath(key)
		const metaTmpPath = this.metaTmpPath(key)

		const serialized = this.serialize(data)
		const hash = this.computeHash(serialized)
		const timestamp = Date.now()

		const meta: DiskCacheMeta = {
			timestamp,
			etag: etag ?? null,
			hash,
		}

		try {
			// 1. Write data file
			await Bun.write(dataPath, serialized)

			// 2. Write meta to temp file
			await Bun.write(metaTmpPath, JSON.stringify(meta))

			// 3. Atomic rename
			await rename(metaTmpPath, metaPath)

			// 4. Update index
			this.index.set(key, { timestamp, etag: etag ?? null, hash })
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
	}

	/**
	 * Get the etag for a cached entry.
	 */
	getEtag(key: string): string | null {
		return this.index.get(key)?.etag ?? null
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
			etag: entry.etag,
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
