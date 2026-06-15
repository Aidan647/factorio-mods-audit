import z from "zod"
import { ModInfo, ModList, ModListItem, Release } from "./types"
import { MemoryCache, DiskCache } from "../helpers/cache"
import { createRateLimiter } from "../helpers/ratelimiter"
import { scanBuffer } from "../helpers/scanfile"

//  https://mods.factorio.com/{download_url}?username={username}&token={token}

export type ModPortalConfig = {
	username: string
	token: string
	baseUrl?: string
	disableDiskCache?: boolean
	disableClamAv?: boolean
	cacheExpiryMs?: number
}

export class ModPortal {
	readonly config: Required<ModPortalConfig>
	private readonly modInfoCache: MemoryCache<ModInfo>
	private downloadCachePromise: Promise<DiskCache<Buffer>> | null = null
	private downloadCache: DiskCache<Buffer> | null = null
	private readonly ratelimiter = createRateLimiter(1, 5)
	readonly tokenValidation: Promise<void>
	constructor(config: ModPortalConfig) {
		this.config = Object.freeze({
			baseUrl: "https://mods.factorio.com/",
			disableDiskCache: false,
			cacheExpiryMs: 30 * 24 * 60 * 60 * 1000,
			disableClamAv: false,
			...config,
		})
		console.log("ModPortal initialized")

		// In-memory cache for mod info (short TTL)
		this.modInfoCache = new MemoryCache<ModInfo>({
			expiryMs: 5 * 60 * 1000, // 5m
			pruneIntervalMs: 5 * 60 * 1000, // 5m
			maxSize: 250,
		})

		// Start token validation in background — awaited in ensureDownloadCache
		this.tokenValidation = this.validateToken()
	}

	/**
	 * Validate the configured username+token by hitting the bookmarks endpoint.
	 * Throws if the response indicates invalid credentials.
	 */
	private async validateToken(): Promise<void> {
		const url = `${this.config.baseUrl}api/bookmarks?username=${this.config.username}&token=${this.config.token}`
		const response = await fetch(url)
		if (!response.ok)
			if (response.status === 403) throw new Error(`Invalid username or token.`)
			else throw new Error(`Failed to validate ModPortal token: ${response.statusText}`)
	}

	private async ensureDownloadCache(): Promise<DiskCache<Buffer> | null> {
		// Validate token before using the download cache
		await this.tokenValidation.catch((err: Error) => {
			console.error(`ModPortal: ${err.message}`)
			process.exit(1)
		})
		if (this.config.disableDiskCache) return null
		if (!this.downloadCache) {
			if (!this.downloadCachePromise) {
				const expiryMs = this.config.cacheExpiryMs ?? 30 * 24 * 60 * 60 * 1000
				this.downloadCachePromise = DiskCache.create<Buffer>({
					cacheDir: process.env.MODPORTAL_CACHE_DIR || "./data/cache/modportal",
					extension: ".zip",
					expiryMs,
					pruneIntervalMs: expiryMs / 48,
				})
			}
			this.downloadCache = await this.downloadCachePromise
		}
		return this.downloadCache
	}
	private async fetch(url: string): Promise<Response> {
		await this.ratelimiter.acquire()
		const response = await fetch(url)
		if (!response.ok) {
			throw new Error(`Failed to download mod: ${response.statusText}`)
		}
		return response
	}
	async getModInfo(modName: string): Promise<ModInfo> {
		// Try memory cache first
		const cached = this.modInfoCache.get(modName)
		if (cached) return cached
		const response = await this.fetch(`${this.config.baseUrl}api/mods/${modName}`)
		const parsed = ModInfo.parse(await response.json())
		this.modInfoCache.set(modName, parsed)
		return parsed
	}
	async getLatestMods({ count = 30, page = 1 } = {}): Promise<ModList> {
		const response = await this.fetch(
			`${this.config.baseUrl}api/mods?page=${page}&page_size=${count}&sort=updated_at&sort_order=desc`,
		)
		const parsed = ModList.parse(await response.json())
		return parsed
	}
	async getPopularMods(): Promise<ModListItem[]> {
		const response = await this.fetch(`${this.config.baseUrl}api/mods?page_size=max`)
		const parsed = ModList.parse(await response.json())
		return parsed.results.sort((a, b) => b.score - a.score)
	}
	async getMostDownloadedMods(): Promise<ModListItem[]> {
		const response = await this.fetch(`${this.config.baseUrl}api/mods?page_size=max`)
		const parsed = ModList.parse(await response.json())
		return parsed.results.sort((a, b) => b.downloads_count - a.downloads_count)
	}
	async getModsByAuthor(...authors: string[]): Promise<ModListItem[]> {
		const response = await this.fetch(`${this.config.baseUrl}api/mods?page_size=max`)
		const parsed = ModList.parse(await response.json())
		return parsed.results.filter((mod) => authors.includes(mod.owner))
	}
	async downloadLatestRelease(modName: string) {
		const modInfo = await this.getModInfo(modName)
		const latestRelease: Release | undefined = modInfo.releases[modInfo.releases.length - 1]
		if (!latestRelease) {
			throw new Error(`No releases found for mod ${modName}`)
		}

		return this.downloadRelease(latestRelease)
	}

	async downloadRelease(data: Release) {
		const downloadUrl = `${this.config.baseUrl}${data.download_url}?username=${this.config.username}&token=${this.config.token}`
		const downloadCache = await this.ensureDownloadCache()

		if (downloadCache) {
			const cachedBuf = await downloadCache.get(data.sha1)
			if (cachedBuf) return cachedBuf
		}
		const response = await this.fetch(downloadUrl)
		const fileBuffer = Buffer.from(await response.arrayBuffer())
		// validate hash
		const hashBuffer = new Bun.CryptoHasher("sha1").update(fileBuffer).digest("hex")
		if (hashBuffer !== data.sha1) {
			throw new Error(`Hash mismatch: expected ${data.sha1}, got ${hashBuffer}`)
		}

		// scan for malware before caching
		if (!this.config.disableClamAv) {
			const verdict = await scanBuffer(fileBuffer)
			if (verdict === "ScanError") {
				throw new Error("Error scanning file for malware")
			} else if (verdict === "Malicious") {
				throw new Error("File is malicious")
			}
		}

		// Store on disk (include sha1 as etag)
		await downloadCache?.set(data.sha1, fileBuffer).catch(() => {})
		return fileBuffer
	}
}
export default ModPortal
