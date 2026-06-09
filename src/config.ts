export type ScanConfig = {
	cacheDir: string
	reportsDir: string
	indexPath: string
}

export const defaultConfig: ScanConfig = {
	cacheDir: "./cache/tmp",
	reportsDir: "./reports",
	indexPath: "./cache/scanned.json",
}
