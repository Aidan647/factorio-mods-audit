import { describe, expect, test } from "bun:test"
import { MetadataScanner } from "../../src/scanner/metadata"
import { ReportBuilder } from "../../src/report"
import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { ModListItem } from "../../src/modportal/types"

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

describe("MetadataScanner", () => {
	test("id and weight are set", () => {
		const scanner = new MetadataScanner()
		expect(scanner.id).toBe("metadata")
		expect(scanner.weight).toBe(20)
	})

	test("returns perfect score for valid info.json", async () => {
		const dir = await mkdtemp(join(tmpdir(), "metadata-test-"))
		await writeFile(
			join(dir, "info.json"),
			JSON.stringify({
				name: "test-mod",
				version: "1.0.0",
				title: "Test Mod",
				author: "test",
				factorio_version: "2.0",
			}),
		)

		const sorter = new ReportBuilder(makeMod())
		const result = await new MetadataScanner().scan(dir, sorter)
		expect(result.score).toBe(100)
		expect(result.findings).toHaveLength(0)
		expect(result.id).toBe("metadata")
	})

	test("returns score 0 for invalid info.json", async () => {
		const dir = await mkdtemp(join(tmpdir(), "metadata-test-"))
		await writeFile(join(dir, "info.json"), JSON.stringify({ name: "x" }))

		const sorter = new ReportBuilder(makeMod())
		const result = await new MetadataScanner().scan(dir, sorter)
		expect(result.score).toBe(0)
		expect(result.findings.length).toBeGreaterThan(0)
		expect(result.findings[0]!.type).toBe("InvalidInfoJson")
	})

	test("flags invalid dependency format", async () => {
		const dir = await mkdtemp(join(tmpdir(), "metadata-test-"))
		await writeFile(
			join(dir, "info.json"),
			JSON.stringify({
				name: "test-mod",
				version: "1.0.0",
				title: "Test Mod",
				author: "test",
				factorio_version: "2.0",
				dependencies: ["valid-dep >= 1.0.0", "???bad format!!!"],
			}),
		)

		const sorter = new ReportBuilder(makeMod())
		const result = await new MetadataScanner().scan(dir, sorter)
		expect(result.score).toBe(75) // 100 - 1*25
		expect(result.findings).toHaveLength(1)
		expect(result.findings[0]!.type).toBe("InvalidDependency")
	})

	test("handles missing info.json gracefully", async () => {
		const dir = await mkdtemp(join(tmpdir(), "metadata-test-"))

		const sorter = new ReportBuilder(makeMod())
		const result = await new MetadataScanner().scan(dir, sorter)
		expect(result.score).toBe(0)
		expect(result.findings.length).toBeGreaterThan(0)
	})
})
