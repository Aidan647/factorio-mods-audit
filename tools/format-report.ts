#!/usr/bin/env bun
/**
 * Convert AuditReport JSON files to human-readable formats.
 *
 * Usage:
 *   bun run tools/format-report.ts <input> [options]
 *
 * Arguments:
 *   input           Path to a report JSON file or a directory of JSON files.
 *                   Defaults to ./reports/found
 *
 * Options:
 *   --format, -f    Output format: txt, md, html (default: auto from output path or txt)
 *   --output, -o    Output path. If input is a directory, this is treated as an output
 *                   directory. If omitted, writes to stdout.
 *   --quiet, -q     Suppress progress logs.
 *
 * Examples:
 *   bun tools/format-report.ts reports/found/jetpack-0.4.17.json
 *   bun tools/format-report.ts reports/found/ --format=md --output=./reports-md/
 *   bun tools/format-report.ts reports/found/jetpack-0.4.17.json --format=html -o report.html
 */

import { readFile, mkdir, writeFile } from "node:fs/promises"
import { readdir } from "node:fs/promises"
import { extname, join, basename, resolve } from "node:path"
import { formatTxt, formatMd, formatHtml } from "../src/report/formatters"
import type { AuditReport } from "../src/report"

type Format = "txt" | "md" | "html"

function parseArgs(): { input: string; format: Format; output: string | null; quiet: boolean } {
	const args = process.argv.slice(2)
	let input = "./data/reports/found"
	let format: Format | null = null
	let output: string | null = null
	let quiet = false

	for (let i = 0; i < args.length; i++) {
		const a = args[i]!

		function consumeValue(flag: string): string | null {
			if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1)
			if (a === flag) return args[++i] ?? null
			return null
		}

		const fmtVal = consumeValue("--format") ?? consumeValue("-f")
		if (fmtVal !== null) {
			if (fmtVal !== "txt" && fmtVal !== "md" && fmtVal !== "html") {
				console.error(`Invalid format "${fmtVal}". Use txt, md, or html.`)
				process.exit(1)
			}
			format = fmtVal
			continue
		}

		const outVal = consumeValue("--output") ?? consumeValue("-o")
		if (outVal !== null) {
			output = outVal
			continue
		}

		if (a === "--quiet" || a === "-q") {
			quiet = true
			continue
		}

		if (!a.startsWith("-")) {
			input = a
			continue
		}

		console.error(`Unknown option: ${a}`)
		process.exit(1)
	}

	// Auto-detect format from output extension if not explicit
	if (!format && output) {
		const ext = extname(output).toLowerCase()
		if (ext === ".md" || ext === ".markdown") format = "md"
		else if (ext === ".html" || ext === ".htm") format = "html"
		else format = "txt"
	}
	format ??= "txt"

	return { input, format, output, quiet }
}

function formatReport(report: AuditReport, format: Format): string {
	switch (format) {
		case "txt":
			return formatTxt(report)
		case "md":
			return formatMd(report)
		case "html":
			return formatHtml(report)
	}
}

const extForFormat: Record<Format, string> = {
	txt: ".txt",
	md: ".md",
	html: ".html",
}

async function main() {
	const { input, format, output, quiet } = parseArgs()

	const stat = await import("node:fs").then((fs) => fs.promises.stat(input).catch(() => null))
	if (!stat) {
		console.error(`Input not found: ${input}`)
		process.exit(1)
	}

	const isDir = stat.isDirectory()
	const isSingleFile = !isDir

	if (isSingleFile) {
		// Single file mode
		const raw = await readFile(input, "utf-8")
		const report = JSON.parse(raw) as AuditReport
		const formatted = formatReport(report, format)

		if (output) {
			await mkdir(resolve(output, ".."), { recursive: true })
			await writeFile(output, formatted, "utf-8")
			if (!quiet) console.log(`Written: ${output}`)
		} else {
			console.log(formatted)
		}
	} else {
		// Directory mode -- convert all JSON reports
		const files = (await readdir(input)).filter((f) => f.endsWith(".json"))
		if (files.length === 0) {
			if (!quiet) console.log(`No JSON files found in ${input}`)
			return
		}

		const outDir = output ?? join(input, `../reports-${format}`)
		await mkdir(outDir, { recursive: true })

		for (const file of files) {
			const raw = await readFile(join(input, file), "utf-8").catch(() => null)
			if (!raw) continue
			const report = JSON.parse(raw) as AuditReport
			const formatted = formatReport(report, format)
			const outName = basename(file, ".json") + extForFormat[format]
			const outPath = join(outDir, outName)
			await writeFile(outPath, formatted, "utf-8")
			if (!quiet) console.log(`  ${outName}`)
		}
		if (!quiet) console.log(`\n${files.length} reports written to ${outDir}`)
	}
}

main().catch((err) => {
	console.error("Error:", err.message)
	process.exit(1)
})
