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

	return report
}
