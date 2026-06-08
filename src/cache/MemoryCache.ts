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
}

/**
 * In-memory cache with LRU eviction.
 * Supports dynamic max size adjustment for memory pressure handling.
 */
export class MemoryCache<T> {
	private readonly cache = new Map<string, CacheEntry<T>>()
	private pruneTimer: ReturnType<typeof setInterval> | null = null

	private readonly expiryMs: number
	private maxSize: number | undefined

	constructor(options: MemoryCacheOptions<T>) {
		this.expiryMs = options.expiryMs
		this.maxSize = options.maxSize

		if (options.pruneIntervalMs) {
			this.pruneTimer = setInterval(() => this.prune(), options.pruneIntervalMs)
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
	 * Stop prune scheduler and clean up resources.
	 */
	destroy(): void {
		if (this.pruneTimer) {
			clearInterval(this.pruneTimer)
			this.pruneTimer = null
		}
	}
}

export default MemoryCache
