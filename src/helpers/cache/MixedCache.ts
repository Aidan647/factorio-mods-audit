import { DiskCache } from "./DiskCache"
import { MemoryCache } from "./MemoryCache"

/** Statistics for cache operations */
export interface MixedCacheStats {
	l1Hits: number
	l1Misses: number
	l2Hits: number
	l2Misses: number
	serverFetches: number
	l1Size: number
	l2Size: number
	dirtyCount: number
	currentMaxSize: number
}

/** Full metadata for stale entries that can be revalidated */
export interface StaleMetadata {
	timestamp: number
	hash: string
}

export interface MixedCacheOptions<T> {
	/** Directory to store cache files */
	cacheDir: string
	/** File extension for data files (e.g., ".png", ".json") */
	extension: string
	/** Serialize data to Buffer/string for disk. Default: identity (assumes T is Buffer | string) */
	serialize?: (data: T) => Buffer | string | Promise<Buffer | string>
	/** Deserialize Buffer from disk to T. Default: identity (returns Buffer as T) */
	deserialize?: (raw: Buffer) => T | undefined | Promise<T | undefined>
	/** Verify hash on disk read. Default: true */
	verifyOnRead?: boolean

	/** Number of hex chars per nesting level for subdirectory splitting. E.g. [2,2] → ab/cd/{key}.ext */
	splitFolders?: number[]

	/** Skip loading L2 entries into L1 on init (start with empty L1). Default: false */
	skipCacheLoading?: boolean

	/** L1 (memory) cache expiry in milliseconds - used for prune scheduling */
	memoryExpiryMs: number
	/** L2 (disk) cache expiry in milliseconds - determines when entries are stale */
	diskExpiryMs: number

	/** Minimum guaranteed L1 size (entries). Used to calculate step size. */
	minMemorySize: number
	/** Maximum RSS memory in MB before aggressive shrinking. */
	maxMemoryMB: number
	/** Interval to check memory pressure in milliseconds. Default: 5000 */
	memoryCheckIntervalMs?: number

	/** L1 prune interval in milliseconds. If set, starts L1 prune scheduler */
	memoryPruneIntervalMs?: number
	/** L2 prune interval in milliseconds. If set, starts L2 prune scheduler */
	diskPruneIntervalMs?: number

	/** Write policy: 'through' = immediate L2 write, 'back' = write on eviction/flush. Default: 'through' */
	writePolicy?: "through" | "back"
	/** Flush timeout in milliseconds for graceful shutdown. Default: 10000 */
	flushTimeoutMs?: number
}

/** Absolute maximum L1 size cap */
const ABSOLUTE_MAX_SIZE = 8192

/**
 * Two-level cache with L1 (memory) and L2 (disk) layers.
 * Features:
 * - Dynamic L1 sizing based on RSS memory pressure
 * - Batch operations for efficient multi-key access
 * - Graceful shutdown with dirty entry flushing
 *
 * Use `MixedCache.create()` to instantiate.
 */
export class MixedCache<T> {
	private readonly l1: MemoryCache<T>
	private readonly l2: DiskCache<T>
	private readonly dirty = new Set<string>()

	private memoryCheckTimer: ReturnType<typeof setInterval> | null = null
	private l1PruneTimer: ReturnType<typeof setInterval> | null = null
	private l2PruneTimer: ReturnType<typeof setInterval> | null = null
	private isShuttingDown = false
	private signalHandlers: { signal: string; handler: () => void }[] = []

	private readonly memoryExpiryMs: number
	private readonly diskExpiryMs: number
	private readonly minMemorySize: number
	private readonly maxMemoryMB: number
	private readonly stepSize: number
	private readonly writePolicy: "through" | "back"
	private readonly flushTimeoutMs: number
	private readonly skipCacheLoading: boolean

	private currentMaxSize: number

	// Stats tracking
	private stats = {
		l1Hits: 0,
		l1Misses: 0,
		l2Hits: 0,
		l2Misses: 0,
		serverFetches: 0,
	}

	private constructor(
		l1: MemoryCache<T>,
		l2: DiskCache<T>,
		options: Required<
			Omit<
				MixedCacheOptions<T>,
				| "serialize"
				| "deserialize"
				| "verifyOnRead"
				| "memoryPruneIntervalMs"
				| "diskPruneIntervalMs"
				| "splitFolders"
				| "skipCacheLoading"
			>
		> & {
			serialize?: (data: T) => Buffer | string | Promise<Buffer | string>
			deserialize?: (raw: Buffer) => T | undefined | Promise<T | undefined>
			verifyOnRead?: boolean
			memoryPruneIntervalMs?: number
			diskPruneIntervalMs?: number
			splitFolders?: number[]
			skipCacheLoading?: boolean
		},
	) {
		this.l1 = l1
		this.l2 = l2

		this.memoryExpiryMs = options.memoryExpiryMs
		this.diskExpiryMs = options.diskExpiryMs
		this.minMemorySize = options.minMemorySize
		this.maxMemoryMB = options.maxMemoryMB
		this.writePolicy = options.writePolicy
		this.flushTimeoutMs = options.flushTimeoutMs
		this.skipCacheLoading = options.skipCacheLoading ?? false

		// Calculate step size: 20% of minSize, minimum 10
		this.stepSize = Math.max(10, Math.floor(this.minMemorySize * 0.2))

		// Initialize currentMaxSize: minSize + 1 step, capped at absolute max
		this.currentMaxSize = Math.min(this.minMemorySize + this.stepSize, ABSOLUTE_MAX_SIZE)
		this.l1.setMaxSize(this.currentMaxSize)

		// Start memory pressure monitoring
		if (options.memoryCheckIntervalMs) {
			this.memoryCheckTimer = setInterval(() => this.checkMemoryPressure(), options.memoryCheckIntervalMs)
		}

		// Start L1 prune scheduler
		if (options.memoryPruneIntervalMs) {
			this.l1PruneTimer = setInterval(() => this.pruneL1(), options.memoryPruneIntervalMs)
		}

		// Start L2 prune scheduler
		if (options.diskPruneIntervalMs) {
			this.l2PruneTimer = setInterval(() => this.pruneL2(), options.diskPruneIntervalMs)
		}

		// Register signal handlers for write-back mode
		if (this.writePolicy === "back") {
			this.registerSignalHandlers()
		}
	}

	/**
	 * Create and initialize a MixedCache instance.
	 */
	static async create<T>(options: MixedCacheOptions<T>): Promise<MixedCache<T>> {
		const opts = {
			...options,
			memoryCheckIntervalMs: options.memoryCheckIntervalMs ?? 5000,
			writePolicy: options.writePolicy ?? "through",
			flushTimeoutMs: options.flushTimeoutMs ?? 10_000,
			splitFolders: options.splitFolders ?? [],
			skipLoadingScanCache: options.skipCacheLoading ?? false,
		}

		// Create L2 (disk cache)
		const l2 = await DiskCache.create<T>({
			cacheDir: opts.cacheDir,
			extension: opts.extension,
			expiryMs: opts.diskExpiryMs,
			serialize: opts.serialize,
			deserialize: opts.deserialize,
			verifyOnRead: opts.verifyOnRead,
			splitFolders: opts.splitFolders,
			skipCacheLoading: opts.skipLoadingScanCache,
		})

		// Create L1 (memory cache)
		const l1 = new MemoryCache<T>({
			expiryMs: opts.memoryExpiryMs,
		})

		return new MixedCache<T>(l1, l2, opts)
	}

	private registerSignalHandlers(): void {
		const signals = ["SIGINT", "SIGTERM"] as const

		for (const signal of signals) {
			const handler = () => this.handleShutdown(signal)
			this.signalHandlers.push({ signal, handler })
			process.on(signal, handler)
		}
	}

	private handleShutdown(signal: string): Promise<void> {
		this.isShuttingDown = true
		console.log(`MixedCache: received ${signal}, flushing dirty entries...`)
		this.destroy()
		return this.flush().catch((err) => console.error("MixedCache: flush error during shutdown:", err))
	}

	private checkMemoryPressure(): void {
		const rssBytes = process.memoryUsage().rss
		const rssMB = rssBytes / 1024 / 1024
		const rssPercent = rssMB / this.maxMemoryMB

		const l1Size = this.l1.size()
		const l1Percent = l1Size / this.currentMaxSize

		// Shrink logic based on RSS thresholds
		if (rssPercent > 1.1) {
			// >110%: emergency shrink by 10 steps
			this.adjustMaxSize(-10 * this.stepSize)
		} else if (rssPercent >= 1.0) {
			// ≥100%: shrink by 5 steps
			this.adjustMaxSize(-5 * this.stepSize)
		} else if (rssPercent > 0.9) {
			// >90%: shrink by 2 steps
			this.adjustMaxSize(-2 * this.stepSize)
		} else if (l1Percent > 0.9 && rssPercent < 0.5) {
			// L1 >90% full AND RSS <50%: grow by 3 step
			this.adjustMaxSize(3 * this.stepSize)
		} else if (l1Percent > 0.9 && rssPercent < 0.7) {
			// L1 >90% full AND RSS <70%: grow by 1 step
			this.adjustMaxSize(this.stepSize)
		}
	}

	private adjustMaxSize(delta: number): void {
		const newSize = this.currentMaxSize + delta

		// Clamp between minMemorySize and ABSOLUTE_MAX_SIZE
		this.currentMaxSize = Math.max(this.minMemorySize, Math.min(newSize, ABSOLUTE_MAX_SIZE))
		this.l1.setMaxSize(this.currentMaxSize)

		// If shrinking and L1 exceeds new max, shrink with flush-then-evict
		if (delta < 0 && this.l1.size() > this.currentMaxSize) {
			this.shrinkL1WithFlush(this.currentMaxSize).catch(() => {})
		}
	}

	private async shrinkL1WithFlush(targetSize: number): Promise<void> {
		// In write-back mode, flush dirty entries that will be evicted
		if (this.writePolicy === "back") {
			const keysToEvict: string[] = []
			let count = 0
			const toEvict = this.l1.size() - targetSize

			for (const key of this.l1.keys()) {
				if (count >= toEvict) break
				keysToEvict.push(key)
				count++
			}

			// Flush dirty entries sequentially
			for (const key of keysToEvict) {
				if (this.dirty.has(key)) {
					const data = this.l1.get(key)
					if (data !== undefined) {
						await this.l2.set(key, data).catch(() => {})
					}
					this.dirty.delete(key)
				}
			}
		}

		this.l1.shrink(targetSize)
	}

	/**
	 * Get a value from cache.
	 * Tries L1 first, then L2 (promoting to L1 on hit).
	 * Returns undefined if not found or expired.
	 * Stale L2 entries are preserved for etag revalidation.
	 */
	async get(key: string): Promise<T | undefined> {
		// Try L1 first
		const l1Value = this.l1.get(key)
		if (l1Value !== undefined) {
			this.stats.l1Hits++
			return l1Value
		}
		this.stats.l1Misses++
		if (this.skipCacheLoading) {
			return undefined
		}
		// Try L2
		const l2Timestamp = this.l2.getTimestamp(key)
		if (l2Timestamp === undefined) {
			this.stats.l2Misses++
			return undefined
		}

		const now = Date.now()
		const age = now - l2Timestamp

		// Check if beyond max stale age (should be pruned)
		if (age >= this.diskExpiryMs) {
			await this.l2.delete(key)
			this.stats.l2Misses++
			return undefined
		}

		// Fresh - read and promote to L1
		const l2Value = await this.l2.get(key)
		if (l2Value === undefined) {
			this.stats.l2Misses++
			return undefined
		}

		this.stats.l2Hits++
		this.l1.set(key, l2Value)
		return l2Value
	}

	/**
	 * Store a value in cache with optional etag.
	 * Write-through: immediately writes to L2.
	 * Write-back: marks entry dirty for later flush.
	 */
	set(key: string, data: T): void {
		// Set in L1
		this.l1.set(key, data)

		// Handle L2
		if (this.writePolicy === "through") {
			this.l2.set(key, data).catch(() => console.error(`MixedCache: failed to write key ${key} to L2`))
		} else {
			this.dirty.add(key)
		}

		this.stats.serverFetches++
	}

	/**
	 * Check if a key exists and is not stale.
	 */
	has(key: string): boolean {
		if (this.l1.has(key)) return true

		const timestamp = this.l2.getTimestamp(key)
		if (timestamp === undefined) return false

		return Date.now() - timestamp < this.diskExpiryMs
	}

	/**
	 * Check if a key exists in L2 but is stale.
	 */
	isStale(key: string): boolean {
		const timestamp = this.l2.getTimestamp(key)
		if (timestamp === undefined) return false

		const age = Date.now() - timestamp
		return age >= this.diskExpiryMs
	}

	/**
	 * Get metadata for a stale entry for etag revalidation.
	 * Returns null if entry doesn't exist or isn't stale.
	 */
	getStaleMetadata(key: string): StaleMetadata | null {
		const timestamp = this.l2.getTimestamp(key)
		if (timestamp === undefined) return null

		const age = Date.now() - timestamp
		if (age < this.diskExpiryMs) {
			return null
		}

		// Get hash from L2 entries
		const entries = this.l2.entries()
		for (const [k, entry] of entries) {
			if (k === key) {
				return {
					timestamp,
					hash: entry.hash,
				}
			}
		}

		return null
	}

	/**
	 * Touch a key: update timestamps and promote L2 to L1.
	 * Used on 304 responses to refresh cache validity.
	 */
	async touch(key: string): Promise<void> {
		// Touch L2 first
		await this.l2.touch(key)

		// Update L1 timestamp if present
		if (this.l1.touch(key)) {
			return
		}

		// Promote from L2 to L1
		const l2Value = await this.l2.get(key)
		if (l2Value !== undefined) {
			this.l1.set(key, l2Value)
		}
	}

	/**
	 * Delete an entry from both caches.
	 */
	async delete(key: string): Promise<boolean> {
		this.dirty.delete(key)
		const l1Deleted = this.l1.delete(key)
		const l2Deleted = await this.l2.delete(key)
		return l1Deleted || l2Deleted
	}

	/**
	 * Get multiple values in parallel.
	 * Returns array of {key, data} for hits, null for misses.
	 */
	async getMany(keys: string[]): Promise<Array<{ key: string; data: T } | null>> {
		return Promise.all(
			keys.map(async (key) => {
				const data = await this.get(key)
				return data !== undefined ? { key, data } : null
			}),
		)
	}

	/**
	 * Set multiple values.
	 * Write-through: sequential writes for disk I/O safety.
	 * Write-back: parallel writes (L1 only, L2 deferred).
	 * Returns succeeded and failed keys.
	 */
	async setMany(entries: Array<{ key: string; data: T }>): Promise<void> {
		for (const { key, data } of entries) {
			this.set(key, data)
		}
	}

	/**
	 * Flush all dirty entries to L2.
	 */
	async flush(): Promise<void> {
		if (this.dirty.size === 0) return

		// Flush sequentially for disk I/O safety
		for (const key of this.dirty) {
			const data = this.l1.get(key)
			if (data !== undefined) {
				await this.l2.set(key, data).catch(() => {})
			}
			this.dirty.delete(key)
		}
	}

	/**
	 * Prune expired entries from L1.
	 */
	pruneL1(): number {
		return this.l1.prune()
	}

	/**
	 * Prune old stale entries from L2.
	 * Removes entries older than diskExpiryMs + maxStaleAgeMs.
	 */
	async pruneL2(): Promise<number> {
		return this.l2.prune(this.diskExpiryMs)
	}

	/**
	 * Get cache statistics.
	 */
	getStats(): MixedCacheStats {
		return {
			...this.stats,
			l1Size: this.l1.size(),
			l2Size: this.l2.size(),
			dirtyCount: this.dirty.size,
			currentMaxSize: this.currentMaxSize,
		}
	}

	/**
	 * Get the underlying L1 (memory) cache.
	 */
	getL1(): MemoryCache<T> {
		return this.l1
	}

	/**
	 * Get the underlying L2 (disk) cache.
	 */
	getL2(): DiskCache<T> {
		return this.l2
	}

	/**
	 * Get current dynamic max size for L1.
	 */
	getCurrentMaxSize(): number {
		return this.currentMaxSize
	}

	get saveAwaiter(): Promise<void> {
		return this.l2.saveAwaiter
	}

	/**
	 * Stop all schedulers, remove signal handlers, and clean up.
	 */
	destroy(): void {
		if (this.memoryCheckTimer) {
			clearInterval(this.memoryCheckTimer)
			this.memoryCheckTimer = null
		}
		if (this.l1PruneTimer) {
			clearInterval(this.l1PruneTimer)
			this.l1PruneTimer = null
		}
		if (this.l2PruneTimer) {
			clearInterval(this.l2PruneTimer)
			this.l2PruneTimer = null
		}

		// Remove signal handlers
		for (const { signal, handler } of this.signalHandlers) {
			process.off(signal, handler)
		}
		this.signalHandlers = []

		this.l1.destroy()
		this.l2.destroy()
	}
}

export default MixedCache
