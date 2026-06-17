#!/usr/bin/env bun
/**
 * Scan a Factorio mod zip file from disk without downloading.
 *
 * Usage:
 *   bun run tools/scan-zip.ts <path-to-zip> [--json | --md | --html | --txt] [--no-clamav]
 */

import fs from "fs/promises"
import path from "path"
import crypto from "node:crypto"
import { loadConfig, type ScanConfig } from "../src/config"
import { formatTxt, formatMd, formatHtml } from "../src/report/formatters"
import Orchestrator from "../src/scanner"
import ModPortal from "../src/modportal"
import type { ModListItem } from "../src/modportal/types"

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const zipPath = args.find((a) => !a.startsWith("--"))
let format: "txt" | "json" | "md" | "html" = "txt"
let disableClamAv = false

for (const flag of args) {
	if (flag === "--json") format = "json"
	else if (flag === "--md") format = "md"
	else if (flag === "--html") format = "html"
	else if (flag === "--txt") format = "txt"
	else if (flag === "--no-clamav") disableClamAv = true
}

if (!zipPath) {
	console.error("Usage: bun run tools/scan-zip.ts <path-to-zip> [--json | --md | --html | --txt] [--no-clamav]")
	process.exit(1)
}

// ── Read zip & extract metadata ─────────────────────────────────────────────

const cfg: ScanConfig = loadConfig(disableClamAv ? { disableClamAv: true } : undefined)
const zipBuffer = await fs.readFile(zipPath)
const sha1 = crypto.createHash("sha1").update(zipBuffer).digest("hex")

// Extract info.json to get mod name/version
const { unzip } = await import("unzipit")
const { entries } = await unzip(zipBuffer)

let modName = ""
let modVersion = ""
for (const [entryPath, entry] of Object.entries(entries)) {
	if (entry.isDirectory) continue
	if (!entryPath.endsWith("info.json")) continue
	try {
		const raw = Buffer.from(await entry.arrayBuffer()).toString("utf-8")
		const info = JSON.parse(raw)
		if (info.name && info.version) {
			modName = info.name
			modVersion = info.version
			break
		}
	} catch {
		continue
	}
}

if (!modName) {
	console.error("Could not find a valid info.json in the zip")
	process.exit(1)
}

// Build mock ModListItem
const modListItem: ModListItem = {
	name: modName,
	title: modName,
	category: null,
	downloads_count: 0,
	owner: "local",
	score: 0,
	summary: "",
	latest_release: {
		download_url: "",
		file_name: path.basename(zipPath),
		info_json: { factorio_version: "1.1" },
		released_at: new Date().toISOString(),
		sha1,
		version: modVersion,
	},
}

// ── Scan ────────────────────────────────────────────────────────────────────

const portal = new ModPortal({} as any)
const scanner = await Orchestrator.create(portal, cfg)

const report = await scanner.scanModFromBuffer(modListItem, zipBuffer)

// ── Output ──────────────────────────────────────────────────────────────────

switch (format) {
	case "json":
		console.log(JSON.stringify(report, null, "\t"))
		break
	case "txt":
		console.log(formatTxt(report))
		break
	case "md":
		console.log(formatMd(report))
		break
	case "html":
		console.log(formatHtml(report))
		break
}

process.exit(0)
