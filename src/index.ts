import { rm } from "fs/promises"
import ModPortal, { type ModPortalConfig } from "./modportal/"
import Scanner from "./scanner"

const config: ModPortalConfig = {
	username: process.env.USERNAME || "username",
	token: process.env.TOKEN || "token",
}
const portal = new ModPortal(config)

const mods = await portal.getMostDownloadedMods().catch((err) => {
	console.log("Error fetching mod info:", err.message)
	return []
})

// await rm("./reports", { recursive: true, force: true })

const scanner = new Scanner(portal)
await scanner.loadIndex()
let scannedCount = 0
for (const mod of mods) {
	if (!mod.latest_release) continue
	const report = await scanner.scanMod(mod)
	if (typeof report === "string") continue
	console.log(`Scanned ${report.modName} v${report.version}`)
	scannedCount++
	if (report.findings) {
		console.log(`- Potential Savings: ${report.percentageSavings?.toFixed(2) ?? "0"}%`)
		console.log(`Findings for ${report.modName} v${report.version}: ${report.findings.length} findings`)
		console.log(`https://mods.factorio.com/mod/${report.modName}`)
	}
	if (report.errors) {
		console.log(`Errors scanning ${report.modName} v${report.version}: ${report.errors.length} errors`)
	}
	if ((report.percentageSavings || 0) > 10) {
		break
	}
	console.log()
}

process.exit(0)
