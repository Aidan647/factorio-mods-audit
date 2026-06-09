import { rm } from "fs/promises"
import { runCLI } from "./cli"
import { defaultConfig } from "./config"

await rm(defaultConfig.reportsDir, { recursive: true, force: true })
await runCLI()
process.exit(0)
