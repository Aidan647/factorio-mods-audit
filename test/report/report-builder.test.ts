import { describe, expect, test } from "bun:test"
import { ReportBuilder } from "../../src/report"
import type { ModListItem } from "../../src/modportal/types"
import type { ScannerResult } from "../../src/scanner/base"

function makeMod(overrides?: Partial<ModListItem>): ModListItem {
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
			version: "1.0.0",
		},
		...overrides,
	}
}

function makeResult(overrides?: Partial<ScannerResult>): ScannerResult {
	return {
		id: "test-scanner",
		score: 100,
		weight: 50,
		savings: 0,
		findings: [],
		...overrides,
	}
}

// Shifted geometric mean with shift=10 to match ReportBuilder.finalScore
function expectedScore(results: { score: number; weight: number }[]): number {
	const shift = 10
	const totalWeight = results.reduce((s, r) => s + r.weight, 0)
	if (totalWeight === 0) return 0
	const product = results.reduce(
		(prod, r) => prod * Math.pow((r.score + shift) / (100 + shift), r.weight / totalWeight),
		1,
	)
	return Math.max(0, Math.min(100, Math.round((100 + shift) * product - shift)))
}

describe("ReportBuilder", () => {
	test("finalScore returns 0 when no scanners", () => {
		const builder = new ReportBuilder(makeMod())
		expect(builder.finalScore).toBe(0)
	})

	test("finalScore returns 100 for a single perfect scanner", () => {
		const builder = new ReportBuilder(makeMod())
		builder.addScannerResult(makeResult({ score: 100, weight: 50 }))
		expect(builder.finalScore).toBe(100)
	})

	test("finalScore returns 0 for a single zero-score scanner", () => {
		const builder = new ReportBuilder(makeMod())
		builder.addScannerResult(makeResult({ score: 0, weight: 50 }))
		expect(builder.finalScore).toBe(0)
	})

	test("finalScore computes shifted geometric mean correctly", () => {
		const builder = new ReportBuilder(makeMod())
		builder.addScannerResult(makeResult({ id: "a", score: 100, weight: 30 }))
		builder.addScannerResult(makeResult({ id: "b", score: 50, weight: 70 }))
		expect(builder.finalScore).toBe(expectedScore([{ score: 100, weight: 30 }, { score: 50, weight: 70 }]))
	})

	test("finalScore clamps to 0-100 range", () => {
		const builder = new ReportBuilder(makeMod())
		builder.addScannerResult(makeResult({ score: -50, weight: 1 }))
		expect(builder.finalScore).toBe(0)
	})

	test("finalScore handles equal weights", () => {
		const builder = new ReportBuilder(makeMod())
		builder.addScannerResult(makeResult({ id: "a", score: 80, weight: 1 }))
		builder.addScannerResult(makeResult({ id: "b", score: 60, weight: 1 }))
		expect(builder.finalScore).toBe(expectedScore([{ score: 80, weight: 1 }, { score: 60, weight: 1 }]))
	})

	test("finalScore: one zero one perfect with equal weights", () => {
		const builder = new ReportBuilder(makeMod())
		builder.addScannerResult(makeResult({ id: "a", score: 100, weight: 1 }))
		builder.addScannerResult(makeResult({ id: "b", score: 0, weight: 1 }))
		expect(builder.finalScore).toBe(expectedScore([{ score: 100, weight: 1 }, { score: 0, weight: 1 }]))
	})

	test("finalScore: low-weight zero scanner doesn't kill score", () => {
		const builder = new ReportBuilder(makeMod())
		builder.addScannerResult(makeResult({ id: "a", score: 100, weight: 90 }))
		builder.addScannerResult(makeResult({ id: "b", score: 0, weight: 10 }))
		expect(builder.finalScore).toBe(expectedScore([{ score: 100, weight: 90 }, { score: 0, weight: 10 }]))
	})

	test("totalSavings sums all scanner savings", () => {
		const builder = new ReportBuilder(makeMod())
		builder.addScannerResult(makeResult({ savings: 100 }))
		builder.addScannerResult(makeResult({ savings: 250 }))
		expect(builder.totalSavings).toBe(350)
	})

	test("totalSavings returns 0 when no scanners", () => {
		const builder = new ReportBuilder(makeMod())
		expect(builder.totalSavings).toBe(0)
	})

	test("addPreflightFinding stores findings", () => {
		const builder = new ReportBuilder(makeMod())
		builder.addPreflightFinding({ type: "Test", description: "test" })
		expect(builder.preflightFindings).toHaveLength(1)
		expect(builder.preflightFindings[0]!.type).toBe("Test")
	})

	test("addError stores errors", () => {
		const builder = new ReportBuilder(makeMod())
		builder.addError(new Error("something broke"))
		expect(builder.errors).toHaveLength(1)
		expect(builder.errors[0]!.message).toBe("something broke")
	})

	test("setModSize sets size", () => {
		const builder = new ReportBuilder(makeMod())
		builder.setModSize(5000)
		expect(builder.modSize).toBe(5000)
	})

	test("saveReport produces correct shape with savings", async () => {
		const builder = new ReportBuilder(makeMod())
		builder.addScannerResult(makeResult({ id: "meta", score: 90, weight: 30, savings: 0 }))
		builder.addScannerResult(makeResult({ id: "clutter", score: 80, weight: 40, savings: 500 }))
		builder.addPreflightFinding({ type: "Warning", description: "something" })
		builder.setModSize(10000)

		const report = await builder.saveReport()
		expect(report.modName).toBe("test-mod")
		expect(report.version).toBe("1.0.0")
		expect(report.sha1).toBe("abc123def456")
		expect(report.score).toBe(expectedScore([{ score: 90, weight: 30 }, { score: 80, weight: 40 }]))
		expect(report.modSize).toBe(10000)
		expect(report.potentialSavings).toBe(500)
		expect(report.percentageSavings).toBe(5)
		expect(report.scanners).toHaveLength(2)
		expect(report.scanners[0]!.id).toBe("meta")
		expect(report.scanners[1]!.id).toBe("clutter")
		expect(report.preflightFindings).toHaveLength(1)
		expect(report.errors).toBeUndefined()
	})

	test("saveReport omits savings when zero", async () => {
		const builder = new ReportBuilder(makeMod())
		builder.addScannerResult(makeResult({ id: "meta", score: 100, weight: 30, savings: 0 }))

		const report = await builder.saveReport()
		expect(report.potentialSavings).toBeUndefined()
		expect(report.percentageSavings).toBeUndefined()
	})

	test("saveReport omits percentageSavings when modSize is 0", async () => {
		const builder = new ReportBuilder(makeMod())
		builder.addScannerResult(makeResult({ id: "clutter", score: 80, weight: 40, savings: 500 }))

		const report = await builder.saveReport()
		expect(report.potentialSavings).toBe(500)
		expect(report.percentageSavings).toBeUndefined()
	})
})
