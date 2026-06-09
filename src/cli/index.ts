import ModPortal, { type ModPortalConfig } from "../modportal/"
import Orchestrator from "../scanner"
import { defaultConfig, type ScanConfig } from "../config"
import { rm } from "fs/promises"

export async function runCLI(config: ScanConfig = defaultConfig): Promise<void> {
	const portalConfig: ModPortalConfig = {
		username: process.env.USERNAME || "username",
		token: process.env.TOKEN || "token",
	}
	const portal = new ModPortal(portalConfig)

	const mods = await portal.getMostDownloadedMods().catch((err) => {
		console.log("Error fetching mod info:", err.message)
		return []
	})

	await rm(config.reportsDir, { recursive: true, force: true }).catch(() => {})

	const scanner = new Orchestrator(portal, config)
	// await scanner.loadIndex()

	for (const mod of mods) {
		if (!mod.latest_release) continue
		const report = await scanner.scanMod(mod)
		if (typeof report === "string") continue
		console.log(`Scanned ${report.modName} v${report.version}`)
		let findingsCount = 0
		for (const sr of report.scanners) {
			findingsCount += sr.findings.length
		}
		console.log(`- Score: ${report.score}/100`)
		for (const sr of report.scanners) {
			console.log(
				`  ${sr.id}: ${sr.score}/100 (weight ${sr.weight}) — ${sr.findings.length} findings, ${sr.savings}B savings`,
			)
		}
		if (report.preflightFindings && report.preflightFindings.length > 0) {
			console.log(`- Preflight findings: ${report.preflightFindings.length}`)
		}
		if (report.errors) {
			console.log(`- Errors scanning ${report.modName} v${report.version}: ${report.errors.length} errors`)
		}
		if (findingsCount > 5) break
		if (report.score < 70) break
		console.log()
	}
}
