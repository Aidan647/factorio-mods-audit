#!/usr/bin/env bun
/**
 * `bun scan <mod-name>` — Scan a single specific mod.
 *
 * Usage:
 *   bun scan my-mod-name           (default: txt output)
 *   bun scan my-mod-name --json
 *   bun scan my-mod-name --md
 *   bun scan my-mod-name --html
 *   bun scan my-mod-name --txt
 */
import { scanSingleMod } from "../cli"
import { loadConfig, type ScanConfig } from "../config"

const args = process.argv.slice(2)
const modName = args.find((a) => !a.startsWith("--"))
const flags = args.filter((a) => a.startsWith("--"))

if (!modName) {
	console.error("Usage: bun scan <mod-name> [--json | --md | --html | --txt] [--no-clamav]")
	process.exit(1)
}

let format: "txt" | "md" | "html" | "json" = "txt"
for (const flag of flags) {
	if (flag === "--json") format = "json"
	else if (flag === "--md") format = "md"
	else if (flag === "--html") format = "html"
	else if (flag === "--txt") format = "txt"
	else if (flag === "--no-clamav") continue
	else {
		console.error(`Unknown flag: ${flag}. Use --json, --md, --html, --txt, or --no-clamav`)
		process.exit(1)
	}
}

const overrides: Partial<ScanConfig> = {}
if (flags.includes("--no-clamav")) {
	overrides.disableClamAv = true
}
const config = loadConfig(overrides)

await scanSingleMod(modName, config, format)
process.exit(0)
