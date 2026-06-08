import ModPortal, { type ModPortalConfig } from "./modportal/"
import { scanBuffer, Verdict } from "./scanfile"

const config: ModPortalConfig = {
	username: process.env.USERNAME || "username",
	token: process.env.TOKEN || "token",
}

const portal = new ModPortal(config)

await portal
	.downloadLatestRelease("speaker-signals-2")
	.then((modInfo) => {
		console.log("speaker-signals-2:", modInfo.length)
	})
	.catch((err) => {
		console.log("Error fetching mod info:", err.message)
	})
const mods = await portal
	.getLatestMods()
	.then((mods) => mods.results)
	.catch((err) => {
		console.log("Error fetching mod info:", err.message)
		return []
	})
console.log("Latest mods:", mods.map((m) => m.name))

for (const mod of mods) {
	if (!mod.latest_release) continue
	console.log(`Scanning latest release of ${mod.name}...`)
	// virus scan is done inside downloadRelease
	await portal
		.downloadRelease(mod.latest_release)
		.catch((err) => {
			console.log(`Error processing ${mod.name}:`, err.message)
		})
	console.log(`Finished processing ${mod.name}`)
}


