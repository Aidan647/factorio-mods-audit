#!/usr/bin/env bun
/**
 * `bun scan-top <popular|downloads> <count>` — Scan top N mods.
 *
 * Usage:
 *   bun scan-top popular 10          (top 10 by popularity score, default: txt)
 *   bun scan-top downloads 5         (top 5 by download count)
 *   bun scan-top popular 3 --json
 *   bun scan-top downloads 10 --md
 *   bun scan-top popular 20 --txt
 *   bun scan-top popular 20 --html
 */
import { scanTopMods } from "../cli"
import { loadConfig, type ScanConfig } from "../config"

const args = process.argv.slice(2)
const sortByRaw = args.find((a) => a === "popular" || a === "downloads")
const countRaw = args.find((a) => /^\d+$/.test(a))
const flags = args.filter((a) => a.startsWith("--"))

if (!sortByRaw || !countRaw) {
	console.error("Usage: bun scan-top <popular|downloads> <count> [--json | --md | --html | --txt] [--no-clamav]")
	console.error("  popular    — Sort mods by popularity score")
	console.error("  downloads  — Sort mods by download count")
	process.exit(1)
}

const sortBy = sortByRaw as "popular" | "downloads"
const count = Number.parseInt(countRaw, 10)

if (count < 1) {
	console.error("Count must be a positive integer.")
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

const reports = await scanTopMods(sortBy, count, config, format)
process.exit(reports.length > 0 ? 0 : 1)
