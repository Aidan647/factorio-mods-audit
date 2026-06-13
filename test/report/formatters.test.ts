import { describe, expect, test } from "bun:test"
import { formatTxt, formatMd, formatHtml } from "../../src/report/formatters"
import type { AuditReport } from "../../src/report"

const sampleReport: AuditReport = {
	modName: "test-mod",
	modNameReadable: "Test Mod",
	version: "1.2.3",
	sha1: "abc123def456",
	timestamp: 1700000000000,
	modSize: 1_250_000,
	score: 72.5,
	potentialSavings: 50_000,
	percentageSavings: 4.0,
	scanners: [
		{
			id: "clutter",
			score: 68.9,
			weight: 80,
			savings: 30_000,
			findings: [
				{
					type: "clutter:osMetadata",
					description: "OS metadata files found.",
					severity: "high",
					potentialSavings: 30_000,
					paths: ["dir/.DS_Store", "dir/thumbs.db"],
				},
			],
		},
		{
			id: "images",
			score: 100,
			weight: 60,
			savings: 0,
			findings: [],
		},
	],
}

const reportWithErrors: AuditReport = {
	...sampleReport,
	errors: ["Failed to download mod", "Checksum mismatch"],
	preflightFindings: [
		{
			type: "preflight:size",
			description: "Mod is unusually large.",
			severity: "medium",
			paths: [],
		},
	],
}

describe("formatTxt", () => {
	test("includes mod name and version", () => {
		const result = formatTxt(sampleReport)
		expect(result).toContain("test-mod")
		expect(result).toContain("1.2.3")
	})

	test("includes score", () => {
		const result = formatTxt(sampleReport)
		expect(result).toContain("72.5")
	})

	test("includes scanner sections", () => {
		const result = formatTxt(sampleReport)
		expect(result).toContain("-- clutter")
		expect(result).toContain("-- images")
	})

	test("includes findings details", () => {
		const result = formatTxt(sampleReport)
		expect(result).toContain("OS metadata files found")
		expect(result).toContain("dir/.DS_Store")
	})

	test("includes pre-flight findings and errors when present", () => {
		const result = formatTxt(reportWithErrors)
		expect(result).toContain("Pre-flight Findings")
		expect(result).toContain("Mod is unusually large")
		expect(result).toContain("Errors")
		expect(result).toContain("Checksum mismatch")
	})

	test("includes size info when available", () => {
		const result = formatTxt(sampleReport)
		expect(result).toContain("1.2")
		expect(result).toContain("MiB")
	})
})

describe("formatMd", () => {
	test("includes markdown heading", () => {
		const result = formatMd(sampleReport)
		expect(result.startsWith("# Mod Audit Report")).toBe(true)
	})

	test("includes metadata table", () => {
		const result = formatMd(sampleReport)
		expect(result).toContain("| **Score** |")
		expect(result).toContain("72.5")
	})

	test("includes scanner sections", () => {
		const result = formatMd(sampleReport)
		expect(result).toContain("### clutter")
		expect(result).toContain("### images")
	})

	test("includes pre-flight and errors when present", () => {
		const result = formatMd(reportWithErrors)
		expect(result).toContain("Pre-flight Findings")
		expect(result).toContain("## Errors")
	})
})

describe("formatHtml", () => {
	test("produces valid HTML document", () => {
		const result = formatHtml(sampleReport)
		expect(result).toContain("<!DOCTYPE html>")
		expect(result).toContain("</html>")
	})

	test("includes mod name and version in title", () => {
		const result = formatHtml(sampleReport)
		expect(result).toContain("test-mod")
		expect(result).toContain("1.2.3")
	})

	test("includes embedded CSS", () => {
		const result = formatHtml(sampleReport)
		expect(result).toContain("<style>")
		expect(result).toContain("</style>")
	})

	test("includes scanner results", () => {
		const result = formatHtml(sampleReport)
		expect(result).toContain("clutter")
		expect(result).toContain("images")
	})

	test("includes pre-flight and errors when present", () => {
		const result = formatHtml(reportWithErrors)
		expect(result).toContain("Pre-flight Findings")
		expect(result).toContain("Errors")
	})

	test("escapes HTML in user content", () => {
		const malicious: AuditReport = {
			...sampleReport,
			modName: "<script>alert('xss')</script>",
		}
		const result = formatHtml(malicious)
		expect(result).not.toContain("<script>")
		expect(result).toContain("&lt;script&gt;")
	})
})
