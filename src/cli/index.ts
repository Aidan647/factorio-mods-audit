import ModPortal, { type ModPortalConfig } from "../modportal/"
import Orchestrator from "../scanner"
import { loadConfig, type ScanConfig } from "../config"
import { readFile, rm } from "fs/promises"
import { readdir } from "node:fs/promises"
import type { AuditReport } from "#/report"
import { formatTxt, formatMd, formatHtml } from "#/report/formatters"
import { bytesToHuman, numberToHuman } from "#/helpers/humanify"

export async function scanSingleMod(
	modName: string,
	config: ScanConfig = loadConfig(),
	format: "txt" | "md" | "html" | "json" = "txt",
): Promise<AuditReport | null> {
	const portalConfig: ModPortalConfig = {
		username: process.env.FACTORIO_USERNAME || process.env.USERNAME || "username",
		token: process.env.FACTORIO_TOKEN || process.env.TOKEN || "token",
		disableDiskCache: config.disableDiskCache,
		disableClamAv: config.disableClamAv,
		cacheExpiryMs: config.cacheExpiryMs,
	}
	const portal = new ModPortal(portalConfig)

	const modInfo = await portal.getModInfo(modName).catch((err: Error) => {
		console.error(`Error fetching mod "${modName}":`, err.message)
		return null
	})
	if (!modInfo) return null

	const latestRelease = modInfo.releases[modInfo.releases.length - 1]
	if (!latestRelease) {
		console.error(`No releases found for mod "${modName}"`)
		return null
	}

	const modListItem = {
		...modInfo,
		latest_release: latestRelease,
	}

	const scanner = await Orchestrator.create(portal, config)

	console.log(`Scanning ${modInfo.title} v${latestRelease.version}...`)
	const report = await scanner.scanMod(modListItem)

	switch (format) {
		case "txt":
			console.log(formatTxt(report))
			break
		case "md":
			console.log(formatMd(report))
			break
		case "html":
			console.log(formatHtml(report))
			break
		case "json":
			console.log(JSON.stringify(report, null, "\t"))
			break
	}
	scanner.reportCache.destroy()
	await scanner.reportCache.saveAwaiter
	return report
}

/**
 * Scan the top N mods by popularity (score) or download count.
 *
 * Usage:
 *   scanTopMods("popular", 10, config, "txt")
 *   scanTopMods("downloads", 5, config, "json")
 */
export async function scanTopMods(
	sortBy: "popular" | "downloads",
	count: number,
	config: ScanConfig = loadConfig(),
	format: "txt" | "md" | "html" | "json" = "txt",
): Promise<AuditReport[]> {
	const portalConfig: ModPortalConfig = {
		username: process.env.FACTORIO_USERNAME || process.env.USERNAME || "username",
		token: process.env.FACTORIO_TOKEN || process.env.TOKEN || "token",
		disableDiskCache: config.disableDiskCache,
		disableClamAv: config.disableClamAv,
		cacheExpiryMs: config.cacheExpiryMs,
	}
	const portal = new ModPortal(portalConfig)
	await portal.tokenValidation

	let mods = sortBy === "popular" ? await portal.getPopularMods() : await portal.getMostDownloadedMods()
	mods = mods.slice(0, count)

	console.log(`\nFetching top ${count} mods by ${sortBy}...`)
	console.log(`Found ${mods.length} mod(s) to scan\n`)

	if (mods.length === 0) {
		console.log("No mods found.")
		return []
	}

	const scanner = await Orchestrator.create(portal, config)
	const reports: AuditReport[] = []

	let i = 0
	for (const mod of mods) {
		i++
		if (!mod.latest_release) {
			console.log(`  [${i}/${mods.length}] ${mod.title} — no latest release, skipping`)
			continue
		}
		console.log(`  [${i}/${mods.length}] Scanning ${mod.title} v${mod.latest_release.version}...`)
		const report = await scanner.scanMod(mod).catch((err: Error) => {
			console.error(`    Error scanning ${mod.title}: ${err.message}`)
			return null
		})
		if (!report) continue
		reports.push(report)

		switch (format) {
			case "txt":
				console.log(formatTxt(report))
				break
			case "md":
				console.log(formatMd(report))
				break
			case "html":
				console.log(formatHtml(report))
				break
			case "json":
				console.log(JSON.stringify(report, null, "\t"))
				break
		}
	}

	// Summary
	console.log("\n" + "=".repeat(60))
	console.log("  SUMMARY")
	console.log("=".repeat(60))
	console.log(`  Scanned ${reports.length}/${mods.length} mod(s)`)
	const avgScore = reports.reduce((sum, r) => sum + r.score, 0) / (reports.length || 1)
	console.log(`  Average score: ${avgScore.toFixed(1)} / 100`)
	console.log("")

	scanner.reportCache.destroy()
	await scanner.reportCache.saveAwaiter
	return reports
}
