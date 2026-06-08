# src/tools/cache

Reusable caching layer with L1 (memory), L2 (disk), and coordinated two-tier caching.

## Overview

- **MemoryCache<T>** — In-memory cache with LRU eviction and dynamic sizing support
- **DiskCache<T>** — Disk-based cache with atomic writes, hash verification, and etag support
- **MixedCache<T>** — Two-level cache coordinating L1+L2 with etag-based stale revalidation and dynamic memory sizing

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        MixedCache                           │
│  ┌─────────────────┐    ┌────────────────────────────────┐ │
│  │   MemoryCache   │    │          DiskCache             │ │
│  │     (L1)        │ ←→ │           (L2)                 │ │
│  │  Fast, volatile │    │  Persistent, etag+hash         │ │
│  └─────────────────┘    └────────────────────────────────┘ │
│                                                             │
│  Features:                                                  │
│  • Dynamic L1 sizing based on RSS memory pressure           │
│  • Write-through or write-back with etag preservation       │
│  • Stale entry support for conditional request revalidation │
│  • Batch operations: getMany(), setMany()                   │
│  • Graceful shutdown with SIGINT/SIGTERM handling           │
└─────────────────────────────────────────────────────────────┘
```

## MixedCache (Recommended)

The primary interface for tiered caching. Manages L1 and L2 internally with:

### Dynamic Memory Sizing

L1 cache size adapts based on RSS memory pressure:

```
Step size = max(10, floor(minMemorySize × 0.15))
Initial size = minMemorySize + stepSize (capped at 8192)

Memory adaptation (checked every memoryCheckIntervalMs):
├── RSS > 110%: shrink by 10 steps (emergency)
├── RSS ≥ 100%: shrink by 5 steps
├── RSS > 90%:  shrink by 2 steps
└── L1 > 90% full AND RSS < 70%: grow by 1 step
```

### Stale Entry Revalidation

Entries remain in L2 beyond `diskExpiryMs` for etag-based conditional requests:

```
Timeline:
├── 0 to diskExpiryMs: Fresh (returned by get())
├── diskExpiryMs to diskExpiryMs + maxStaleAgeMs: Stale (get() returns undefined, etag available)
└── Beyond maxStaleAgeMs: Pruned (deleted on next access or prune)
```

Use `isStale()` and `getStaleMetadata()` to check for revalidation candidates:

```ts
const cache = await MixedCache.create<Buffer>({ ... })

const data = await cache.get(key)
if (data) return data // Cache hit

if (cache.isStale(key)) {
  const meta = cache.getStaleMetadata(key)
  // Make conditional request with If-None-Match: meta.etag
  // On 304: await cache.touch(key) to refresh
}
```

### API

```ts
// Create
const cache = await MixedCache.create<Buffer>({
  cacheDir: "./cache/tiles",
  extension: ".png",
  memoryExpiryMs: 5 * 60 * 1000,     // L1 expiry (for prune)
  diskExpiryMs: 15 * 60 * 1000,      // L2 expiry (fresh → stale threshold)
  maxStaleAgeMs: 7 * 24 * 60 * 60 * 1000, // How long to keep stale entries (default: 7 days)
  minMemorySize: 100,                 // Minimum guaranteed L1 entries
  maxMemoryMB: 512,                   // RSS limit for memory pressure
  memoryCheckIntervalMs: 5000,        // Memory check interval (default: 5s)
  memoryPruneIntervalMs: 60_000,      // Optional L1 auto-prune
  diskPruneIntervalMs: 300_000,       // Optional L2 auto-prune
  writePolicy: "through",             // or "back"
  verifyOnRead: true,                 // Hash verification (default: true)
})

// Core operations
await cache.set(key, data, etag?)
const data = await cache.get(key)     // L1 → L2 fallback, undefined if stale
await cache.delete(key)
cache.has(key)                        // true if fresh (not stale)

// Stale entry handling
cache.isStale(key)                    // true if expired but revalidatable
cache.getStaleMetadata(key)           // { etag, timestamp, hash } or null
cache.getEtag(key)                    // etag or null (fresh or stale)
await cache.touch(key)                // Refresh L1+L2 timestamps, promotes L2→L1

// Batch operations
await cache.getMany(keys)             // Array<{ key, data } | null>
await cache.setMany(entries)          // { succeeded: string[], failed: string[] }

// Write-back mode
await cache.flush()                   // Flush dirty entries to L2

// Prune
cache.pruneL1()                       // Remove expired L1 entries
await cache.pruneL2()                 // Remove old stale L2 entries

// Stats
cache.getStats()                      // { l1Hits, l1Misses, l2Hits, l2Misses, etagHits, ... }
cache.getCurrentMaxSize()             // Current dynamic L1 max size

// Advanced: access underlying caches
cache.getL1()                         // MemoryCache<T>
cache.getL2()                         // DiskCache<T>

// Cleanup
cache.destroy()                       // Stop schedulers, remove signal handlers
```

## MemoryCache (Standalone)

Simple in-memory cache with LRU eviction. Used internally by MixedCache.

### API

```ts
const cache = new MemoryCache<string>({
	expiryMs: 60_000,
	maxSize: 1000, // Optional LRU limit
	pruneIntervalMs: 30_000, // Optional auto-prune
})

// Operations (all synchronous)
cache.set(key, data)
const data = cache.get(key)
cache.has(key)
cache.delete(key)
cache.touch(key) // Refresh timestamp and LRU position
cache.prune() // Remove expired entries

// Dynamic sizing
cache.setMaxSize(newMax) // Change LRU limit
cache.getMaxSize() // Current limit
cache.shrink(targetSize) // Evict LRU entries down to target

// Iteration
cache.keys()
cache.entries()
cache.size()

// Cleanup
cache.destroy()
```

## DiskCache (Standalone)

Disk-based cache with atomic writes and integrity verification. Used internally by MixedCache.

### Features

- **Atomic writes**: `.meta.tmp` → rename to `.meta` (crash-safe)
- **Hash verification**: Detects disk corruption on read
- **Etag support**: Store and retrieve HTTP ETags

### API

```ts
const cache = await DiskCache.create<Buffer>({
  cacheDir: "./cache",
  extension: ".png",
  expiryMs: 15 * 60 * 1000,
  verifyOnRead: true,         // Default: true
  pruneIntervalMs: 60_000     // Optional auto-prune
})

// Operations
await cache.set(key, data, etag?)
const data = await cache.get(key)
cache.getEtag(key)            // Sync, from index
cache.getTimestamp(key)       // Sync, from index
await cache.touch(key)        // Refresh timestamp
await cache.delete(key)
await cache.prune(maxAgeMs?)  // Remove expired entries

// Iteration
cache.keys()
cache.entries()               // [key, { timestamp, etag, hash }]
cache.size()

// Cleanup
cache.destroy()
```

## Usage Example

```ts
import { MixedCache } from "./cache"

// Create tiered cache with dynamic sizing
const tileCache = await MixedCache.create<Buffer>({
	cacheDir: "./cache/tiles",
	extension: ".png",
	memoryExpiryMs: 5 * 60 * 1000,
	diskExpiryMs: 15 * 60 * 1000,
	maxStaleAgeMs: 7 * 24 * 60 * 60 * 1000,
	minMemorySize: 100,
	maxMemoryMB: 512,
})

// Fetch tile with stale revalidation
async function getTile(key: string): Promise<Buffer> {
	// Try cache first
	const cached = await tileCache.get(key)
	if (cached) return cached

	// Check for stale entry with etag
	const staleMeta = tileCache.getStaleMetadata(key)
	const headers: Record<string, string> = {}
	if (staleMeta) {
		headers["If-None-Match"] = staleMeta.etag
	}

	const response = await fetch(`https://example.com/tiles/${key}.png`, { headers })

	if (response.status === 304 && staleMeta) {
		// Not modified - refresh timestamps and promote to L1
		await tileCache.touch(key)
		return (await tileCache.get(key))!
	}

	// New data
	const buffer = Buffer.from(await response.arrayBuffer())
	const etag = response.headers.get("ETag") ?? undefined
	await tileCache.set(key, buffer, etag)
	return buffer
}

// Cleanup on shutdown
process.on("beforeExit", () => tileCache.destroy())
```
