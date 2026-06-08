/**
 * Abstract base class for rate limiters with shared queue and retry-after logic
 */
export abstract class RateLimiter {
	protected queue: Array<() => void> = []
	protected retryAfter = 0
	protected processing = false

	constructor(protected readonly maxPerSecond: number) {}

	/**
	 * Acquire permission to make a request. Waits if rate limit exceeded or Retry-After active.
	 */
	async acquire(): Promise<void> {
		return new Promise((resolve) => {
			this.queue.push(resolve)
			this.processQueue()
		})
	}

	/**
	 * Set Retry-After delay from server response (in seconds)
	 */
	setRetryAfter(seconds: number): void {
		this.retryAfter = Date.now() + seconds * 1000
		this.resetTokens()
	}

	/**
	 * Reset tokens/state when retry-after is set (child-specific)
	 */
	protected abstract resetTokens(): void

	/**
	 * Process a single request according to child's rate limiting strategy
	 */
	protected abstract processRequest(): Promise<void>

	protected releaseNext(): void {
		const resolve = this.queue.shift()
		if (resolve) resolve()
	}

	protected async processQueue(): Promise<void> {
		if (this.processing || this.queue.length === 0) return
		this.processing = true

		const now = Date.now()

		// Check Retry-After
		if (this.retryAfter > now) {
			const sleepMs = this.retryAfter - now
			await Bun.sleep(sleepMs)
			this.retryAfter = 0
			this.processing = false
			queueMicrotask(() => this.processQueue())
			return
		}

		// Delegate to child's rate limiting logic
		await this.processRequest()

		this.releaseNext()
		this.processing = false
		queueMicrotask(() => this.processQueue())
	}
}

/**
 * Token bucket rate limiter with burst capacity
 */
export class BurstRateLimiter extends RateLimiter {
	private tokens: number
	private lastRefill = Date.now()

	constructor(
		maxPerSecond: number,
		private readonly burstCapacity: number,
	) {
		super(maxPerSecond)
		this.tokens = burstCapacity
	}

	protected resetTokens(): void {
		this.tokens = 0
		this.lastRefill = this.retryAfter
	}

	protected async processRequest(): Promise<void> {
		const now = Date.now()

		// Refill tokens based on time elapsed
		const elapsed = now - this.lastRefill
		const tokensToAdd = (elapsed / 1000) * this.maxPerSecond
		this.tokens = Math.min(this.burstCapacity, this.tokens + tokensToAdd)
		this.lastRefill = now

		// Check if we have tokens available
		if (this.tokens < 1) {
			// Wait for next token
			const waitTime = (1 - this.tokens) * (1000 / this.maxPerSecond)
			await Bun.sleep(waitTime)
			// Re-process after sleep (will refill tokens)
			this.processing = false
			queueMicrotask(() => this.processQueue())
			return
		}

		// Consume token
		this.tokens -= 1
	}
}

/**
 * Fixed-interval rate limiter without burst capacity
 */
export class SteadyRateLimiter extends RateLimiter {
	private lastRelease = 0

	protected resetTokens(): void {
		this.lastRelease = this.retryAfter
	}

	protected async processRequest(): Promise<void> {
		const now = Date.now()
		const timeSinceRelease = now - this.lastRelease

		// Handle zero maxPerSecond to avoid infinite loop
		if (this.maxPerSecond === 0) {
			this.lastRelease = now
			return
		}

		const minInterval = 1000 / this.maxPerSecond

		if (timeSinceRelease < minInterval) {
			await Bun.sleep(minInterval - timeSinceRelease)
		}

		this.lastRelease = Date.now()
	}
}

/**
 * Factory function to create rate limiters
 */
export function createRateLimiter(maxPerSecond: number): SteadyRateLimiter
export function createRateLimiter(maxPerSecond: number, burstCapacity: number): BurstRateLimiter
export function createRateLimiter(maxPerSecond: number, burstCapacity?: number): SteadyRateLimiter | BurstRateLimiter {
	if (burstCapacity !== undefined) {
		return new BurstRateLimiter(maxPerSecond, burstCapacity)
	}
	return new SteadyRateLimiter(maxPerSecond)
}
export default createRateLimiter
