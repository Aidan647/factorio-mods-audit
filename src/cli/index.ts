import ModPortal, { type ModPortalConfig } from "../modportal/"
import Orchestrator from "../scanner"
import { defaultConfig, type ScanConfig } from "../config"
import { readFile, rm } from "fs/promises"
import { readdir } from "node:fs/promises"
import type { AuditReport } from "#/report"

/**
 * Convert bytes to a human-readable string with appropriate units (B, kiB, MiB, GiB).
 * Formats to 4 significant digits (e.g. 123.4kiB, 22.66GiB).
 */
function bytesToHuman(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	const units = ["B", "kiB", "MiB", "GiB", "TiB"]
	const exponent = Math.floor(Math.log(bytes) / Math.log(1024))
	const value = bytes / Math.pow(1024, exponent)
	const digits = Math.max(0, 3 - Math.floor(Math.log10(value)))
	return `${value.toFixed(digits)} ${units[exponent]}`
}
function numberToHuman(num: number): string {
	if (num < 1000) return `${num}`
	const units = ["", "k", "M", "B", "T"]
	const exponent = Math.floor(Math.log(num) / Math.log(1000))
	const value = num / Math.pow(1000, exponent)
	const digits = Math.max(0, 3 - Math.floor(Math.log10(value)))
	return `${value.toFixed(digits)}${units[exponent]}`
}

export async function runCLI(config: ScanConfig = defaultConfig): Promise<void> {
	const portalConfig: ModPortalConfig = {
		username: process.env.USERNAME || "username",
		token: process.env.TOKEN || "token",
	}
	const portal = new ModPortal(portalConfig)
	let stopped = false
	process.on("SIGINT", async (reason) => {
		stopped = true
		console.log(
			`Scan interrupted (${reason}). Finishing current scan and loading reports... (Press Ctrl+C again to force exit)`,
		)

		// load all finding form ./reports/found/ and print top 20 most badly scored mods, then exit
		await readdir("./reports/found").then(async (files) => {
			const reports = (
				await Promise.all(
					files.map((file) =>
						readFile(`./reports/found/${file}`, "utf-8")
							.then((mod) => JSON.parse(mod) as AuditReport)
							.catch(() => null),
					),
				)
			).filter((r): r is AuditReport => r !== null)
			reports.sort((a, b) => a.score - b.score)
			console.log("Top 20 lowest scored mods:")
			for (let i = 0; i < Math.min(20, reports.length); i++) {
				const r = reports[i]
				if (!r) continue
				console.log(`${i + 1}. ${r.modName} v${r.version} - Score: ${r.score}/100`)
			}
		})
		process.exit(0)
	})
	const mods = await portal.getMostDownloadedMods().catch((err) => {
		console.log("Error fetching mod info:", err.message)
		return []
	})

	await rm(config.reportsDir, { recursive: true, force: true }).catch(() => {})

	const scanner = new Orchestrator(portal, config)
	// await scanner.loadIndex()

	for (const mod of mods) {
		if (!mod.latest_release) continue
		console.log(
			`Scanned ${mod.title} v${mod.latest_release.version} (${numberToHuman(mod.downloads_count)} downloads)`,
		)
		if (stopped) break
		const report = await scanner.scanMod(mod)
		if (typeof report === "string") continue
		let findingsCount = 0
		for (const sr of report.scanners) {
			findingsCount += sr.findings.length
		}
		console.log(`- Score: ${report.score}/100`)
		for (const sr of report.scanners) {
			if (sr.score === 100) continue
			console.log(
				`  ${sr.id}: ${sr.score}/100 (weight ${sr.weight}) — ${sr.findings.length} findings, ${bytesToHuman(sr.savings)} savings`,
			)
		}
		if (report.preflightFindings && report.preflightFindings.length > 0) {
			console.log(`- Preflight findings: ${report.preflightFindings.length}`)
		}
		if (report.errors) {
			console.log(`- Errors scanning ${report.modName} v${report.version}: ${report.errors.length} errors`)
		}
		// if (findingsCount > 5) break
		// if (report.score < 70) break
		for (const sr of report.scanners) {
			for (const finding of sr.findings) {
				if (finding.type === "clutter:extra-parent-entry") break
			}
		}

		console.log()
	}
}
