import { describe, expect, test } from "bun:test"
import { parseChangelog, isValidVersion, ChangelogScanner } from "../../src/scanner/changelog"
import { ReportBuilder } from "../../src/report"
import type { ModListItem } from "../../src/modportal/types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMod(version = "1.1.60"): ModListItem {
	return {
		name: "test-mod",
		category: null,
		downloads_count: 100,
		owner: "test",
		score: 0,
		summary: "A test mod",
		title: "Test Mod",
		latest_release: {
			download_url: "https://example.com/test-mod.zip",
			file_name: "test-mod.zip",
			info_json: { factorio_version: "2.0" },
			released_at: "2024-01-01T00:00:00Z",
			sha1: "abc123def456",
			version,
		},
	}
}

// ---------------------------------------------------------------------------
// Sample changelogs
// ---------------------------------------------------------------------------

const SAMPLE_CHANGELOG = `---------------------------------------------------------------------------------------------------
Version: 1.1.60
Date: 06. 06. 2022
  Features:
    - This is an entry in the "Features" category.
    - This is another entry in the "Features" category.
  Balancing:
    - This is a multiline entry in the "Balancing" category.
      There is some extra text here because it is needed for the example.
  Bugfixes:
    - Fixed that canceling syncing mods with a save would exit the GUI.
    - Fixed a desync when fast-replacing burner generators.
---------------------------------------------------------------------------------------------------
Version: 1.1.59
Date: 06. 05. 2022
  Bugfixes:
    - Fixed grenade shadows.`

const CHANGELOG_NO_DATE = `---------------------------------------------------------------------------------------------------
Version: 2.0.0
  Features:
    - Something cool.`

const CHANGELOG_EMPTY_DATE = `---------------------------------------------------------------------------------------------------
Version: 2.0.0
Date:
  Features:
    - Something cool.`

const CHANGELOG_VERSION_MISMATCH = `---------------------------------------------------------------------------------------------------
Version: 1.0.0
Date: 01. 01. 2024
  Bugfixes:
    - Fixed something.`

const CHANGELOG_INVALID_VERSION = `---------------------------------------------------------------------------------------------------
Version: 0.0.0
Date: 01. 01. 2024
  Bugfixes:
    - Fixed something.`

// ---------------------------------------------------------------------------
// isValidVersion
// ---------------------------------------------------------------------------

describe("isValidVersion", () => {
	test("valid versions", () => {
		expect(isValidVersion("1.1.60")).toBe(true)
		expect(isValidVersion("0.1.0")).toBe(true)
		expect(isValidVersion("2.0.0")).toBe(true)
		expect(isValidVersion("0.0.1")).toBe(true)
		expect(isValidVersion("65535.65535.65535")).toBe(true)
	})

	test("invalid versions", () => {
		expect(isValidVersion("0.0.0")).toBe(false)
		expect(isValidVersion("1.2")).toBe(false)
		expect(isValidVersion("1.2.3.4")).toBe(false)
		expect(isValidVersion("abc")).toBe(false)
		expect(isValidVersion("1.2.abc")).toBe(false)
		expect(isValidVersion("-1.0.0")).toBe(false)
		expect(isValidVersion("65536.0.0")).toBe(false)
		expect(isValidVersion("")).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// parseChangelog — unit tests for the parser
// ---------------------------------------------------------------------------

describe("parseChangelog", () => {
	test("parses the first (latest) version section fully", () => {
		const result = parseChangelog(SAMPLE_CHANGELOG)
		expect(result.sections).toHaveLength(1) // only latest section
		expect(result.errors).toEqual([])

		const latest = result.sections[0]
		expect(latest?.version).toBe("1.1.60")
		expect(latest?.date).toBe("06. 06. 2022")
	})

	test("parses categories from latest section only", () => {
		const result = parseChangelog(SAMPLE_CHANGELOG)
		const latest = result.sections[0]!

		expect(latest.categories.has("Features")).toBe(true)
		expect(latest.categories.has("Balancing")).toBe(true)
		expect(latest.categories.has("Bugfixes")).toBe(true)
		// "Major Features" is in a later section, not the latest
		expect(latest.categories.has("Major Features")).toBe(false)
	})

	test("parses entries within categories", () => {
		const result = parseChangelog(SAMPLE_CHANGELOG)
		const latest = result.sections[0]!
		const features = latest.categories.get("Features")!

		expect(features).toHaveLength(2)
		expect(features[0]).toBe('This is an entry in the "Features" category.')
		expect(features[1]).toBe('This is another entry in the "Features" category.')
	})

	test("handles multiline entries, joining continuation lines", () => {
		const result = parseChangelog(SAMPLE_CHANGELOG)
		const latest = result.sections[0]!
		const balancing = latest.categories.get("Balancing")!

		expect(balancing).toHaveLength(1)
		expect(balancing[0]).toContain("multiline entry")
		expect(balancing[0]).toContain("extra text")
	})

	test("handles missing date (date field absent)", () => {
		const result = parseChangelog(CHANGELOG_NO_DATE)
		expect(result.sections[0]?.version).toBe("2.0.0")
		expect(result.sections[0]?.date).toBeNull()
	})

	test("handles empty date (Date: with no value)", () => {
		const result = parseChangelog(CHANGELOG_EMPTY_DATE)
		expect(result.sections[0]?.version).toBe("2.0.0")
		expect(result.sections[0]?.date).toBe("")
	})

	test("reports error for missing 99-dash line", () => {
		const result = parseChangelog("some random text")
		expect(result.sections).toHaveLength(0)
		expect(result.errors.length).toBeGreaterThan(0)
		expect(result.errors.some((e) => e.includes("no version section start"))).toBe(true)
	})

	test("reports error when line after dashes is empty", () => {
		const result = parseChangelog(
			"---------------------------------------------------------------------------------------------------\n\n",
		)
		expect(result.sections).toHaveLength(0)
		expect(result.errors.some((e) => e.includes("must not be empty"))).toBe(true)
	})

	test("does not parse sections beyond the first", () => {
		const result = parseChangelog(SAMPLE_CHANGELOG)
		expect(result.sections).toHaveLength(1)
	})

	test("parses real-world multi-section changelog correctly", () => {
		const changelog = `---------------------------------------------------------------------------------------------------
Version: 0.7.2
Date: 22. 09. 2025
  Info:
    - Factorio 2.0 Mod portal release version.

  Changes:
    - Added missing reactor glow for Factorio 2.0

---------------------------------------------------------------------------------------------------
Version: 0.7.1
Date: 09. 12. 2024
  Changes:
    - Updated for Factorio 2.0

---------------------------------------------------------------------------------------------------
Version: 0.6.2
Date: 11. 014. 2023
  Changes:
    - Added construction and radar construction pylon base sprites.

---------------------------------------------------------------------------------------------------
Version: 0.6.1
Date: 18. 04. 2022
  Changes:
    - Added core seam graphics.

---------------------------------------------------------------------------------------------------
Version: 0.1.1
Date: 06. 06. 2021
  Info:
    - First version.`
		const result = parseChangelog(changelog)
		expect(result.errors).toEqual([])
		expect(result.sections).toHaveLength(1)

		const latest = result.sections[0]!
		expect(latest.version).toBe("0.7.2")
		expect(latest.date).toBe("22. 09. 2025")
		expect(latest.categories.has("Info")).toBe(true)
		expect(latest.categories.has("Changes")).toBe(true)
		expect(latest.categories.get("Info")).toEqual(["Factorio 2.0 Mod portal release version."])
		expect(latest.categories.get("Changes")).toEqual(["Added missing reactor glow for Factorio 2.0"])
	})

	test("handles CRLF (\\r\\n) line endings", () => {
		const crlf =
			"---------------------------------------------------------------------------------------------------\r\nVersion: 1.1.60\r\nDate: 06. 06. 2022\r\n  Features:\r\n    - Entry one.\r\n    - Entry two.\r\n"
		const result = parseChangelog(crlf)
		expect(result.errors).toEqual([])
		expect(result.sections).toHaveLength(1)
		expect(result.sections[0]!.version).toBe("1.1.60")
		expect(result.sections[0]!.date).toBe("06. 06. 2022")
		expect(result.sections[0]!.categories.get("Features")).toEqual(["Entry one.", "Entry two."])
	})
})

// ---------------------------------------------------------------------------
// ChangelogScanner — integration tests using analyze() directly
// ---------------------------------------------------------------------------

describe("ChangelogScanner", () => {
	test("with date: no date-related findings, perfect score", () => {
		const scanner = new ChangelogScanner()
		const builder = new ReportBuilder(makeMod("1.1.60"))
		scanner.analyze(SAMPLE_CHANGELOG, builder)
		const result = scanner.report("", builder)

		expect(result.findings.some((f) => f.type === "MissingChangelogDate")).toBe(false)
		expect(result.findings.some((f) => f.type === "MissingChangelog")).toBe(false)
		expect(result.score).toBe(100)
	})

	test("missing date produces low-severity finding", () => {
		const scanner = new ChangelogScanner()
		const builder = new ReportBuilder(makeMod("2.0.0"))
		scanner.analyze(CHANGELOG_NO_DATE, builder)
		const result = scanner.report("", builder)

		const dateFinding = result.findings.find((f) => f.type === "MissingChangelogDate")
		expect(dateFinding).toBeDefined()
		expect(dateFinding?.severity).toBe("low")
		// 100 * 100/(100+10) ≈ 90.91
		expect(result.score).toBeCloseTo(100 * (100 / 110), 5)
	})

	test("empty date produces low-severity finding", () => {
		const scanner = new ChangelogScanner()
		const builder = new ReportBuilder(makeMod("2.0.0"))
		scanner.analyze(CHANGELOG_EMPTY_DATE, builder)
		const result = scanner.report("", builder)

		const dateFinding = result.findings.find((f) => f.type === "MissingChangelogDate")
		expect(dateFinding).toBeDefined()
		expect(dateFinding?.severity).toBe("low")
		// 100 * 100/(100+10) ≈ 90.91
		expect(result.score).toBeCloseTo(100 * (100 / 110), 5)
	})

	test("version mismatch produces medium-severity finding", () => {
		const scanner = new ChangelogScanner()
		const builder = new ReportBuilder(makeMod("2.0.0"))
		scanner.analyze(CHANGELOG_VERSION_MISMATCH, builder)
		const result = scanner.report("", builder)

		const mismatchFinding = result.findings.find((f) => f.type === "ChangelogVersionMismatch")
		expect(mismatchFinding).toBeDefined()
		expect(mismatchFinding?.severity).toBe("medium")
		// 100 * 100/(100+20) ≈ 83.33
		expect(result.score).toBeCloseTo(100 * (100 / 120), 5)
	})

	test("version 0.0.0 produces high-severity finding", () => {
		const scanner = new ChangelogScanner()
		const builder = new ReportBuilder(makeMod("0.0.0"))
		scanner.analyze(CHANGELOG_INVALID_VERSION, builder)
		const result = scanner.report("", builder)

		const invalidFinding = result.findings.find((f) => f.type === "InvalidChangelogVersion")
		expect(invalidFinding).toBeDefined()
		expect(invalidFinding?.severity).toBe("high")
		// 100 * 100/(100+40) ≈ 71.43
		expect(result.score).toBeCloseTo(100 * (100 / 140), 5)
	})

	test("version mismatch + missing date stack deductions", () => {
		const noDateMismatch = `---------------------------------------------------------------------------------------------------
Version: 1.0.0
  Bugfixes:
    - Fixed something.`

		const scanner = new ChangelogScanner()
		const builder = new ReportBuilder(makeMod("2.0.0"))
		scanner.analyze(noDateMismatch, builder)
		const result = scanner.report("", builder)

		expect(result.findings.some((f) => f.type === "ChangelogVersionMismatch")).toBe(true)
		expect(result.findings.some((f) => f.type === "MissingChangelogDate")).toBe(true)
		// medium(20) + low(10) = 30 total → 100 * 100/(100+30) ≈ 76.92
		expect(result.score).toBeCloseTo(100 * (100 / 130), 5)
	})

	test("real-world changelog produces perfect score when version matches", () => {
		const changelog = `---------------------------------------------------------------------------------------------------
Version: 0.7.2
Date: 22. 09. 2025
  Info:
    - Factorio 2.0 Mod portal release version.

  Changes:
    - Added missing reactor glow for Factorio 2.0

---------------------------------------------------------------------------------------------------
Version: 0.7.1
Date: 09. 12. 2024
  Changes:
    - Updated for Factorio 2.0

---------------------------------------------------------------------------------------------------
Version: 0.6.2
Date: 11. 014. 2023
  Changes:
    - Added construction and radar construction pylon base sprites.

---------------------------------------------------------------------------------------------------
Version: 0.6.1
Date: 18. 04. 2022
  Changes:
    - Added core seam graphics.

---------------------------------------------------------------------------------------------------
Version: 0.1.1
Date: 06. 06. 2021
  Info:
    - First version.`

		const scanner = new ChangelogScanner()
		const builder = new ReportBuilder(makeMod("0.7.2"))
		scanner.analyze(changelog, builder)
		const result = scanner.report("", builder)

		expect(result.findings).toHaveLength(0)
		expect(result.score).toBe(100)
	})
})
