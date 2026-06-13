export type ScanConfig = {
	dataDir: string
	cacheDir: string
	tmpDir: string
	reportsDir: string
	indexPath: string
	disableClamAv: boolean
	disableDiskCache: boolean
	cacheExpiryMs: number
}

function envStr(key: string, fallback: string): string {
	return process.env[key] || fallback
}

function envBool(key: string, fallback: boolean): boolean {
	if (process.env[key] === undefined) return fallback
	return process.env[key] === "1" || process.env[key]?.toLowerCase() === "true"
}

function envNum(key: string, fallback: number): number {
	const v = process.env[key]
	if (v === undefined) return fallback
	const n = Number(v)
	return Number.isFinite(n) ? n : fallback
}

export function loadConfig(overrides?: Partial<ScanConfig>): ScanConfig {
	const dataDir = envStr("DATA_DIR", "./data")
	return {
		dataDir,
		cacheDir: envStr("CACHE_DIR", `${dataDir}/cache`),
		tmpDir: envStr("TMP_DIR", `${dataDir}/cache/tmp`),
		reportsDir: envStr("REPORTS_DIR", `${dataDir}/reports`),
		indexPath: envStr("INDEX_PATH", `${dataDir}/cache/scanned.json`),
		disableClamAv: envBool("DISABLE_CLAMAV", false),
		disableDiskCache: envBool("DISABLE_DISK_CACHE", false),
		cacheExpiryMs: envNum("CACHE_EXPIRY_MS", 30 * 24 * 60 * 60 * 1000),
		...overrides,
	}
}

export const defaultConfig: ScanConfig = loadConfig()
