/** Entry stored in memory cache */
interface CacheEntry<T> {
	timestamp: number
	data: T
}

export interface MemoryCacheOptions<T> {
	/** Cache expiry in milliseconds */
	expiryMs: number
	/** Initial maximum entries before LRU eviction. If unset, no limit. Can be changed at runtime via setMaxSize() */
	maxSize?: number
	/** Auto-prune interval in milliseconds. If set, starts prune scheduler */
	pruneIntervalMs?: number
	/** Maximum RSS memory in MB before aggressive shrinking. Only used when checkIntervalMs is set. */
	maxMemoryMB?: number
	/** Interval to check memory pressure in milliseconds. If set, starts memory pressure monitoring. */
	checkIntervalMs?: number
}

/**
 * Step size as % of maxSize for memory pressure adjustments.
 * Minimum 10 entries.
 */
function calcStepSize(maxSize: number | undefined): number {
	return maxSize ? Math.max(10, Math.floor(maxSize * 0.20)) : 10
}

/** Absolute maximum L1 size cap */
const ABSOLUTE_MAX_SIZE = 8192

/**
 * In-memory cache with LRU eviction and memory-pressure-aware sizing.
 * Supports dynamic max size adjustment for memory pressure handling.
 */
export class MemoryCache<T> {
	private readonly cache = new Map<string, CacheEntry<T>>()
	private pruneTimer: ReturnType<typeof setInterval> | null = null
	private memoryCheckTimer: ReturnType<typeof setInterval> | null = null

	private readonly expiryMs: number
	private maxSize: number | undefined
	private readonly maxMemoryMB: number | undefined
	private readonly stepSize: number

	constructor(options: MemoryCacheOptions<T>) {
		this.expiryMs = options.expiryMs
		this.maxSize = options.maxSize
		this.maxMemoryMB = options.maxMemoryMB
		this.stepSize = calcStepSize(this.maxSize)

		if (options.pruneIntervalMs) {
			this.pruneTimer = setInterval(() => this.prune(), options.pruneIntervalMs)
		}
		if (options.checkIntervalMs && this.maxMemoryMB) {
			this.memoryCheckTimer = setInterval(() => this.checkMemoryPressure(), options.checkIntervalMs)
		}
	}

	/**
	 * Get a value from cache (synchronous).
	 * Moves entry to end for LRU tracking.
	 */
	get(key: string): T | undefined {
		const entry = this.cache.get(key)
		if (!entry) return undefined

		// Check expiry
		if (Date.now() - entry.timestamp >= this.expiryMs) {
			return undefined
		}

		// Move to end for LRU (delete and re-insert)
		this.cache.delete(key)
		this.cache.set(key, entry)

		return entry.data
	}

	/**
	 * Store a value in cache.
	 * Handles LRU eviction if maxSize is set.
	 */
	set(key: string, data: T): void {
		// Handle LRU eviction before inserting
		this.evictIfNeeded()

		// Remove existing entry (to re-insert at end)
		this.cache.delete(key)

		// Insert new entry
		this.cache.set(key, { timestamp: Date.now(), data })
	}

	private evictIfNeeded(): void {
		if (!this.maxSize || this.cache.size < this.maxSize) return

		const oldest = this.cache.keys().next().value as string | undefined
		if (oldest) {
			this.cache.delete(oldest)
		}
	}

	/**
	 * Check if a key exists (not expired).
	 */
	has(key: string): boolean {
		const entry = this.cache.get(key)
		if (!entry) return false
		return Date.now() - entry.timestamp < this.expiryMs
	}

	/**
	 * Delete an entry from cache.
	 */
	delete(key: string): boolean {
		return this.cache.delete(key)
	}

	/**
	 * Remove expired entries.
	 * Returns number of entries pruned.
	 */
	prune(): number {
		const now = Date.now()
		const keysToDelete: string[] = []

		for (const [key, entry] of this.cache) {
			if (now - entry.timestamp >= this.expiryMs) {
				keysToDelete.push(key)
			}
		}

		for (const key of keysToDelete) {
			this.cache.delete(key)
		}

		return keysToDelete.length
	}

	/**
	 * Get number of entries in cache.
	 */
	size(): number {
		return this.cache.size
	}

	/**
	 * Get current max size limit.
	 */
	getMaxSize(): number | undefined {
		return this.maxSize
	}

	/**
	 * Set a new max size limit.
	 * Does not automatically shrink if current size exceeds new limit.
	 * Call shrink() after if needed.
	 */
	setMaxSize(newMaxSize: number | undefined): void {
		this.maxSize = newMaxSize
	}

	/**
	 * Shrink cache to target size by evicting LRU entries.
	 * Returns number of entries evicted.
	 */
	shrink(targetSize: number): number {
		let evicted = 0
		while (this.cache.size > targetSize) {
			const oldest = this.cache.keys().next().value as string | undefined
			if (!oldest) break
			this.cache.delete(oldest)
			evicted++
		}
		return evicted
	}

	/**
	 * Get all cache keys.
	 */
	keys(): IterableIterator<string> {
		return this.cache.keys()
	}

	/**
	 * Get all cache entries.
	 */
	entries(): IterableIterator<[string, CacheEntry<T>]> {
		return this.cache.entries()
	}

	/**
	 * Update timestamp for a key without changing data.
	 * Returns true if key exists and was updated.
	 */
	touch(key: string): boolean {
		const entry = this.cache.get(key)
		if (!entry) return false

		// Move to end for LRU and update timestamp
		this.cache.delete(key)
		entry.timestamp = Date.now()
		this.cache.set(key, entry)
		return true
	}

	/**
	 * Check process RSS memory and shrink cache if exceeding threshold.
	 * No-op if maxMemoryMB was not configured.
	 */
	checkMemoryPressure(): void {
		if (!this.maxMemoryMB || !this.maxSize) return

		const rssBytes = process.memoryUsage().rss
		const rssMB = rssBytes / 1024 / 1024
		const rssPercent = rssMB / this.maxMemoryMB

		const cachePercent = this.cache.size / this.maxSize

		if (rssPercent > 1.1) {
			// >110%: emergency shrink by 10 steps
			this.adjustMaxSize(-10 * this.stepSize)
		} else if (rssPercent >= 1.0) {
			// ≥100%: shrink by 5 steps
			this.adjustMaxSize(-5 * this.stepSize)
		} else if (rssPercent > 0.9) {
			// >90%: shrink by 2 steps
			this.adjustMaxSize(-2 * this.stepSize)
		} else if (cachePercent > 0.8 && rssPercent < 0.6) {
			// Cache >80% full AND RSS <60%: grow by 3 steps
			this.adjustMaxSize(3 * this.stepSize)
		} else if (cachePercent > 0.9 && rssPercent < 0.8) {
			// Cache >90% full AND RSS <80%: grow by 1 step
			this.adjustMaxSize(this.stepSize)
		}
		this.prune() // Also prune expired entries on each check
	}

	private adjustMaxSize(delta: number): void {
		const minSize = Math.max(10, this.stepSize)
		const newSize = (this.maxSize ?? minSize) + delta
		this.maxSize = Math.max(minSize, Math.min(newSize, ABSOLUTE_MAX_SIZE))

		if (this.cache.size > this.maxSize) {
			this.shrink(this.maxSize)
		}
	}

	/**
	 * Stop prune scheduler, memory check timer, and clean up resources.
	 */
	destroy(): void {
		if (this.pruneTimer) {
			clearInterval(this.pruneTimer)
			this.pruneTimer = null
		}
		if (this.memoryCheckTimer) {
			clearInterval(this.memoryCheckTimer)
			this.memoryCheckTimer = null
		}
	}
}

export default MemoryCache
