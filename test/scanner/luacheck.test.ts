import { describe, expect, test } from "bun:test"
import { parseLuacheckOutput, buildReport } from "../../src/scanner/luacheck"

// ---------------------------------------------------------------------------
// parseLuacheckOutput
// ---------------------------------------------------------------------------

describe("parseLuacheckOutput", () => {
	const SAMPLE_OUTPUT = `Checking flib/format.lua                          1 warning

    flib/format.lua:46:20: (W311) value assigned to variable k is overwritten on line 55 before use
    flib/data.lua:12:8: (W211) unused local variable 'foo'

Total: 2 warnings / 0 errors in 29 files`

	test("parses warning lines from full luacheck output", () => {
		const result = parseLuacheckOutput(SAMPLE_OUTPUT)
		expect(result).toHaveLength(2)
	})

	test("extracts file, line, col, code, and message", () => {
		const result = parseLuacheckOutput(SAMPLE_OUTPUT)
		const first = result[0]!
		expect(first.file).toBe("flib/format.lua")
		expect(first.line).toBe(46)
		expect(first.col).toBe(20)
		expect(first.code).toBe("311")
		expect(first.message).toBe("value assigned to variable k is overwritten on line 55 before use")
	})

	test("extracts second warning correctly", () => {
		const result = parseLuacheckOutput(SAMPLE_OUTPUT)
		const second = result[1]!
		expect(second.file).toBe("flib/data.lua")
		expect(second.line).toBe(12)
		expect(second.col).toBe(8)
		expect(second.code).toBe("211")
		expect(second.message).toBe("unused local variable 'foo'")
	})

	test("returns empty array for clean output", () => {
		const clean = "Total: 0 warnings / 0 errors in 29 files"
		expect(parseLuacheckOutput(clean)).toEqual([])
	})

	test("returns empty array for no matching lines", () => {
		const random = "some random text\nwith no luacheck format"
		expect(parseLuacheckOutput(random)).toEqual([])
	})

	test("handles empty output", () => {
		expect(parseLuacheckOutput("")).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// buildReport
// ---------------------------------------------------------------------------

describe("buildReport", () => {
	const DESCRIPTIONS: Record<string, string> = {
		"311": "Value assigned to variable is overwritten before use",
		"211": "Unused local variable",
	}

	test("groups warnings by code", () => {
		const warnings = [
			{ file: "a.lua", line: 1, col: 1, code: "311", message: "msg1" },
			{ file: "b.lua", line: 2, col: 1, code: "311", message: "msg2" },
			{ file: "c.lua", line: 3, col: 1, code: "211", message: "msg3" },
		]
		const result = buildReport(warnings, DESCRIPTIONS)
		expect(result.findings).toHaveLength(2)
	})

	test("uses code description from map", () => {
		const warnings = [{ file: "a.lua", line: 1, col: 1, code: "311", message: "msg" }]
		const result = buildReport(warnings, DESCRIPTIONS)
		expect(result.findings[0]?.description).toBe("311: Value assigned to variable is overwritten before use")
	})

	test("formats paths as file:line:col", () => {
		const warnings = [{ file: "flib/format.lua", line: 46, col: 20, code: "311", message: "msg" }]
		const result = buildReport(warnings, DESCRIPTIONS)
		expect(result.findings[0]?.paths).toEqual(["flib/format.lua:46:20"])
	})

	test("finding type is luacheck:<code>", () => {
		const warnings = [{ file: "a.lua", line: 1, col: 1, code: "311", message: "msg" }]
		const result = buildReport(warnings, DESCRIPTIONS)
		expect(result.findings[0]?.type).toBe("luacheck:311")
	})

	test("handles unknown code with fallback description", () => {
		const warnings = [{ file: "a.lua", line: 1, col: 1, code: "999", message: "something" }]
		const result = buildReport(warnings, {})
		expect(result.findings[0]?.description).toBe("luacheck warning W999")
	})

	test("all findings are low severity", () => {
		const warnings = [{ file: "a.lua", line: 1, col: 1, code: "311", message: "m" }]
		const result = buildReport(warnings, DESCRIPTIONS)
		expect(result.findings[0]?.severity).toBe("low")
	})

	test("score is 100 for zero warnings", () => {
		const result = buildReport([], DESCRIPTIONS)
		expect(result.score).toBe(100)
		expect(result.findings).toHaveLength(0)
	})

	test("25 warnings gives score of 50", () => {
		const warnings = Array.from({ length: 25 }, (_, i) => ({
			file: "a.lua",
			line: i + 1,
			col: 1,
			code: "311",
			message: "m",
		}))
		const result = buildReport(warnings, DESCRIPTIONS)
		expect(result.score).toBeCloseTo(50, 5)
	})

	test("score decreases with more warnings", () => {
		const one = buildReport([{ file: "a.lua", line: 1, col: 1, code: "311", message: "m" }], DESCRIPTIONS)
		const three = buildReport(
			[
				{ file: "a.lua", line: 1, col: 1, code: "311", message: "m" },
				{ file: "b.lua", line: 1, col: 1, code: "311", message: "m" },
				{ file: "c.lua", line: 1, col: 1, code: "211", message: "m" },
			],
			DESCRIPTIONS,
		)
		expect(one.score).toBeGreaterThan(three.score)
	})

	test("all warnings cost the same regardless of code", () => {
		const a = buildReport([{ file: "a.lua", line: 1, col: 1, code: "111", message: "m" }], DESCRIPTIONS)
		const b = buildReport([{ file: "a.lua", line: 1, col: 1, code: "511", message: "m" }], DESCRIPTIONS)
		expect(a.score).toBe(b.score)
	})

	test("savings is always 0", () => {
		const warnings = [{ file: "a.lua", line: 1, col: 1, code: "311", message: "m" }]
		const result = buildReport(warnings, DESCRIPTIONS)
		expect(result.savings).toBe(0)
	})

	test("id is luacheck", () => {
		const result = buildReport([], DESCRIPTIONS)
		expect(result.id).toBe("luacheck")
	})

	test("weight is 85", () => {
		const result = buildReport([], DESCRIPTIONS)
		expect(result.weight).toBe(85)
	})
})
