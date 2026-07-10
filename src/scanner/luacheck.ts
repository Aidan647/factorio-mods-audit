import path from "node:path"
import { mkdir } from "node:fs/promises"
import type { Scanner, ScannerResult } from "./base"
import type { Finding, ReportBuilder } from "../report"
import { loadLuacheckCodes } from "./helpers/luacheck-codes"

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
			const file = m[1] ?? ""
			const lineStr = m[2] ?? "-1"
			const colStr = m[3] ?? "-1"
			const code = m[4] ?? "000"
			const message = m[5] ?? ""
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
	readonly weight = 20
	readonly findings: Finding[] = []

	private warnings: LuacheckWarning[] = []
	private static readonly cacheDir = path.join(
		process.env.CACHE_DIR || path.join(process.cwd(), "data/cache"),
		"luacheck",
	)
	private static readonly luacheckPath = path.join(
		process.env.LUACHECK_PATH || path.join(process.cwd(), "tools/luacheck"),
	)
	private static readonly luacheckRcPath = path.join(
		process.env.LUACHECKRC_PATH || path.join(process.cwd(), "tools/.luacheckrc"),
	)

	static loaded = false
	static codeDescriptions: Record<string, string> = {}

	static async load(): Promise<void> {
		if (LuacheckScanner.loaded) return
		if (!(await Bun.file(LuacheckScanner.luacheckPath).exists())) return
		// run luacheck --version to ensure it works
		const luachekExists = Bun.spawn([LuacheckScanner.luacheckPath, "--version"])

		const makeAwait = mkdir(LuacheckScanner.cacheDir, { recursive: true }).catch(() => {})
		LuacheckScanner.codeDescriptions = await loadLuacheckCodes()
		const [code] = await Promise.all([luachekExists.exited, makeAwait])
		if (code !== 0) {
			console.error("LuacheckScanner cannot run. Please ensure luacheck is built and available.")
			return
		}
		LuacheckScanner.loaded = true
	}

	async scan(modPath: string, _sorter: ReportBuilder): Promise<void> {
		const { stdout, stderr, exitCode } =
			await Bun.$`${LuacheckScanner.luacheckPath} --config ${LuacheckScanner.luacheckRcPath} --no-color --cache ${LuacheckScanner.cacheDir} -- **/*.lua`
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

export function buildReport(
	warnings: LuacheckWarning[],
	codeDescriptions: Record<string, string>,
	weight: number,
): ScannerResult {
	// Determine severity and cost based on warning code prefix
	// 1xx,2xx,3xx → medium (cost 5)
	// 0xx,4xx,5xx → high (cost 7)
	// rest → low (cost 1)
	function getSeverityAndCost(code: string): { severity: "low" | "medium" | "high"; cost: number } {
		const prefix = code.charAt(0)
		if (prefix === "1" || prefix === "2" || prefix === "3") {
			return { severity: "medium", cost: 5 }
		}
		if (prefix === "0" || prefix === "4" || prefix === "5") {
			return { severity: "high", cost: 7 }
		}
		return { severity: "low", cost: 1 }
	}

	// Group warnings by code
	const grouped = new Map<string, LuacheckWarning[]>()
	for (const w of warnings) {
		const existing = grouped.get(w.code)
		if (existing) existing.push(w)
		else grouped.set(w.code, [w])
	}

	// Build a finding per code group with severity based on code prefix
	const findings: Finding[] = []
	let weightedCost = 0
	for (const [code, ws] of grouped) {
		const { severity, cost } = getSeverityAndCost(code)
		const desc = codeDescriptions[code]
		const description = desc ? `${code}: ${desc}` : `luacheck warning W${code}`
		const paths = ws.map((w) => `${w.file}:${w.line}:${w.col}`)
		weightedCost += cost * ws.length
		findings.push({
			type: `luacheck:${code}`,
			description,
			severity,
			paths,
		})
	}

	const score = weightedCost > 0 ? 100 * (400 / (400 + weightedCost)) : 100

	return {
		id: "luacheck",
		score,
		weight,
		savings: 0,
		findings,
	}
}
