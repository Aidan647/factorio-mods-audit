import path from "node:path"
import { mkdir } from "node:fs/promises"
import { readFile } from "node:fs/promises"
import { JSON5 } from "bun"
import type { Scanner, ScannerResult } from "./base"
import type { Finding, ReportBuilder } from "../report"

// ── Types ───────────────────────────────────────────────────────────────────

type LuacheckWarning = {
	file: string
	line: number
	col: number
	code: string
	message: string
}

// ── Constants ───────────────────────────────────────────────────────────────

const LUACHECK_LINE_RE = /^\s+(.+?):(\d+):(\d+):\s*\(W(\d+)\)\s*(.*)$/

// ── Public parser ───────────────────────────────────────────────────────────

/**
 * Parse luacheck plain-text output into structured warnings.
 * Matches lines like: "    file.lua:line:col: (W<code>) message"
 */
export function parseLuacheckOutput(stdout: string): LuacheckWarning[] {
	const warnings: LuacheckWarning[] = []
	for (const line of stdout.split("\n")) {
		const m = line.match(LUACHECK_LINE_RE)
		if (m) {
			const file = m[1]!
			const lineStr = m[2]!
			const colStr = m[3]!
			const code = m[4]!
			const message = m[5]!
			warnings.push({
				file,
				line: Number(lineStr),
				col: Number(colStr),
				code,
				message: message.trim(),
			})
		}
	}
	return warnings
}

// ── Scanner ─────────────────────────────────────────────────────────────────

export class LuacheckScanner implements Scanner {
	readonly id = "luacheck"
	readonly weight = 65
	readonly findings: Finding[] = []

	private warnings: LuacheckWarning[] = []
	private hasRun = false

	static loaded = false
	static codeDescriptions: Record<string, string> = {}

	static async load(): Promise<void> {
		if (LuacheckScanner.loaded) return
		const cfgPath = process.env.LUACHECK_CODES_PATH || path.join(process.cwd(), "data/luacheck-codes.json5")
		const raw = await readFile(cfgPath, "utf-8").catch(() => "{}")
		const parsed = JSON5.parse(raw) as Record<string, string>
		LuacheckScanner.codeDescriptions = parsed
		LuacheckScanner.loaded = true
	}

	async scan(modPath: string, _sorter: ReportBuilder): Promise<void> {
		if (this.hasRun) return
		this.hasRun = true

		const luacheckPath = process.env.LUACHECK_PATH || path.join(process.cwd(), "tools/luacheck")
		const rcPath = process.env.LUACHECKRC_PATH || path.join(process.cwd(), "tools/.luacheckrc")
		const cacheDir = path.join(process.env.CACHE_DIR || path.join(process.cwd(), "data/cache"), "luacheck")
		await mkdir(cacheDir, { recursive: true }).catch(() => {})

		const { stdout, stderr, exitCode } = await Bun.$
			`${luacheckPath} --config ${rcPath} --no-color --cache ${cacheDir} -- **/*.lua`
			.cwd(modPath)
			.quiet()
			.nothrow()
			.then((p) => ({ stdout: p.text(), stderr: p.stderr.toString(), exitCode: p.exitCode }))
			.catch(() => ({ stdout: "", stderr: "luacheck process failed", exitCode: -1 }))

		if (exitCode !== 0 && exitCode !== 1) {
			const msg = stderr.trim() || stdout.trim() || `luacheck exited with code ${exitCode}`
			_sorter.addError(new Error(msg))
			return
		}

		this.warnings = parseLuacheckOutput(stdout)
	}

	/**
	 * Build findings from warnings and compute score.
	 * Exported for testing.
	 */
	report(_modPath: string, _sorter: ReportBuilder): ScannerResult {
		return buildReport(this.warnings, LuacheckScanner.codeDescriptions, this.weight)
	}
}

// ── Pure helpers (exported for testing) ─────────────────────────────────────

export function buildReport(warnings: LuacheckWarning[], codeDescriptions: Record<string, string>, weight: number): ScannerResult {
	// Group warnings by code
	const grouped = new Map<string, LuacheckWarning[]>()
	for (const w of warnings) {
		const existing = grouped.get(w.code)
		if (existing) existing.push(w)
		else grouped.set(w.code, [w])
	}

	// Build a finding per code group — all low severity
	const findings: Finding[] = []
	for (const [code, ws] of grouped) {
		const desc = codeDescriptions[code]
		const description = desc ? `${code}: ${desc}` : `luacheck warning W${code}`
		const paths = ws.map((w) => `${w.file}:${w.line}:${w.col}`)
		findings.push({
			type: `luacheck:${code}`,
			description,
			severity: "low",
			paths,
		})
	}

	// Score: 25 fixed point — 25 warnings = 50 score
	// Formula: 100 * 25 / (25 + totalWarnings)
	const totalWarnings = warnings.length
	const score = totalWarnings > 0 ? 100 * (75 / (75 + totalWarnings)) : 100

	return {
		id: "luacheck",
		score,
		weight,
		savings: 0,
		findings,
	}
}
