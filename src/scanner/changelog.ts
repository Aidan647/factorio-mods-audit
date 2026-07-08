import path from "node:path"
import { readFile } from "node:fs/promises"
import type { Scanner, ScannerResult } from "./base"
import type { Finding, ReportBuilder } from "../report"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VersionSection = {
	version: string
	date: string | null
	categories: Map<string, string[]>
}

export type ChangelogParseResult = {
	sections: VersionSection[]
	/** Line numbers (0-based) of issues found during parsing */
	errors: string[]
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const DASHES99 = "---------------------------------------------------------------------------------------------------"

/**
 * Validate a version string (major.minor.sub, each 0-65535, not 0.0.0)
 */
export function isValidVersion(version: string): boolean {
	const parts = version.split(".")
	if (parts.length !== 3) return false
	if (version === "0.0.0") return false
	for (const part of parts) {
		const num = Number(part)
		if (!Number.isInteger(num) || num < 0 || num > 65535 || isNaN(num)) return false
	}
	return true
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a changelog string following the factorio changelog format.
 * Only the first (latest) version section is fully parsed; subsequent sections
 * are detected but not detailed.
 */
export function parseChangelog(text: string): ChangelogParseResult {
	// Normalize line endings (CRLF → LF, lone CR → LF)
	text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")

	const lines = text.split("\n")
	const sections: VersionSection[] = []
	const errors: string[] = []

	let i = 0

	// Find first section-start line
	while (i < lines.length) {
		const line = lines[i]!
		if (line === DASHES99) break
		if (line.trim() !== "") {
			errors.push(`line ${i}: unexpected content before first version section: "${line.slice(0, 40)}"`)
		}
		i++
	}

	if (i >= lines.length) {
		errors.push("no version section start (99 dashes) found")
		return { sections, errors }
	}

	// ---- parse first (latest) version section ----
	i++ // skip the 99-dash line

	// Line after section start must not be empty
	if (i >= lines.length || lines[i]!.trim() === "") {
		errors.push("line after version section start must not be empty")
		return { sections, errors }
	}

	// Version line
	const versionLine = lines[i]!
	if (!versionLine.startsWith("Version: ")) {
		errors.push(`line ${i}: expected "Version: ", got: "${versionLine.slice(0, 40)}"`)
		return { sections, errors }
	}
	const version = versionLine.slice("Version: ".length).trim()
	i++

	// Date line (optional)
	let date: string | null = null
	if (i < lines.length && (lines[i]!.startsWith("Date: ") || lines[i]! === "Date:")) {
		date = lines[i]!.slice("Date:".length).trim()
		i++
	}

	// Categories & entries
	const categories = new Map<string, string[]>()
	let currentCategory: string | null = null

	while (i < lines.length) {
		const line = lines[i]!

		// Next section start → stop parsing latest section
		if (line === DASHES99) {
			break
		}

		// Skip empty lines
		if (line.trim() === "") {
			i++
			continue
		}

		// Category: starts with exactly 2 spaces, ends with `:`, NOT 4-space prefixed
		if (/^  [^ ]/.test(line) && line.endsWith(":")) {
			currentCategory = line.trim().slice(0, -1)
			categories.set(currentCategory, [])
			i++
			continue
		}

		// Entry: "    - " prefix
		if (line.startsWith("    - ") && currentCategory) {
			const text = line.slice(6)
			categories.get(currentCategory)!.push(text)
			i++
			continue
		}

		// Multiline continuation: 6 spaces
		if (line.startsWith("      ") && currentCategory) {
			const entries = categories.get(currentCategory)!
			if (entries.length > 0) {
				entries[entries.length - 1] = entries[entries.length - 1]! + "\n" + line.slice(6)
			}
			i++
			continue
		}

		// Fallback: treat as unknown line, skip
		errors.push(`line ${i}: unexpected line format: "${line.slice(0, 40)}"`)
		i++
	}

	sections.push({ version, date, categories })
	return { sections, errors }
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Scanner that validates the mod's changelog.txt file against the factorio
 * changelog format specification.
 *
 * Checks performed:
 *  - changelog.txt exists
 *  - First version section is parseable
 *  - Version matches the mod's current version
 *  - Date is present (missing/empty → low-severity finding)
 */
export class ChangelogScanner implements Scanner {
	readonly id = "changelog"
	readonly weight = 30
	readonly findings: Finding[] = []

	static loaded = true

	private parseResult: ChangelogParseResult | null = null
	private fileMissing = false

	async scan(modPath: string, sorter: ReportBuilder): Promise<void> {
		const content = await readFile(path.join(modPath, "changelog.txt"), "utf-8").catch(() => null)
		if (content === null) {
			this.fileMissing = true
			this.findings.push({
				type: "MissingChangelog",
				description: "The mod does not include a changelog.txt file.",
				severity: "high",
			})
			return
		}
		this.analyze(content, sorter)
	}

	/**
	 * Analyze changelog content directly (bypasses file read — useful for tests).
	 * Populates findings based on parsing results, version matching, and date presence.
	 */
	analyze(changelogContent: string, sorter: ReportBuilder): void {
		this.parseResult = parseChangelog(changelogContent)

		// Group all parse errors into a single finding with paths
		if (this.parseResult.errors.length > 0) {
			this.findings.push({
				type: "ChangelogParseError",
				description: "The changelog contains lines that do not follow the expected format.",
				severity: "medium",
				paths: this.parseResult.errors,
			})
		}

		const sections = this.parseResult.sections
		if (sections.length === 0) return

		// Validate latest section's version matches mod version
		const latest = sections[0]!
		if (!isValidVersion(latest.version)) {
			this.findings.push({
				type: "InvalidChangelogVersion",
				description: "The changelog version is not a valid semver (major.minor.sub, not 0.0.0).",
				severity: "high",
				paths: [latest.version],
			})
		} else if (latest.version !== sorter.version) {
			this.findings.push({
				type: "ChangelogVersionMismatch",
				description: "The changelog version does not match the mod version.",
				severity: "medium",
				paths: [latest.version],
			})
		}

		// Check date presence
		if (latest.date === null || latest.date === "") {
			this.findings.push({
				type: "MissingChangelogDate",
				description: "The changelog entry for the latest version has no date.",
				severity: "low",
			})
		}
	}

	report(_modPath: string, _sorter: ReportBuilder): ScannerResult {
		if (this.fileMissing) {
			return {
				id: this.id,
				score: 0,
				weight: this.weight,
				savings: 0,
				findings: this.findings,
			}
		}

		// Score: sum deductions by severity, then apply asymptotic formula
		// score = 100 * (100 / (100 + totalDeductions)) — never reaches 0
		let totalDeductions = 0
		for (const f of this.findings) {
			if (f.severity === "high") totalDeductions += 40
			else if (f.severity === "medium") totalDeductions += 20
			else totalDeductions += 10 // low
		}
		const score = 100 * (100 / (100 + totalDeductions))
		return {
			id: this.id,
			score,
			weight: this.weight,
			savings: 0,
			findings: this.findings,
		}
	}
}
