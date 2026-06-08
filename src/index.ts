import { rm } from "fs/promises"
import ModPortal, { type ModPortalConfig } from "./modportal/"
import { scanBuffer, Verdict } from "./helpers/scanfile"
import  Scanner  from "./scanner"

const config: ModPortalConfig = {
	username: process.env.USERNAME || "username",
	token: process.env.TOKEN || "token",
}
const portal = new ModPortal(config)


const mods = await portal
	.getLatestMods({count: 10})
	.then((mods) => mods.results)
	.catch((err) => {
		console.log("Error fetching mod info:", err.message)
		return []
	})
console.log("Latest mods:", mods.map((m) => m.name))

await rm("./reports", { recursive: true, force: true })

const scanner = new Scanner(portal)
// await scanner.loadIndex()
for (const mod of mods) {
	if (!mod.latest_release) continue
	const report = await scanner.scanMod(mod)
	if (typeof report === "string") continue
	if (report.findings) {
		console.log(`Findings for ${report.modName} v${report.version}: ${report.findings.length} findings`)
		console.log(`https://mods.factorio.com/mod/${report.modName}`);
	}
	if (report.errors) {
		console.log(`Errors scanning ${report.modName} v${report.version}: ${report.errors.length} errors`)
	}
}


process.exit(0)

