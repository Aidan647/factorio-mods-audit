import { describe, expect, test } from "bun:test"
import { ScanIndex } from "../../src/scanner/scan-index"
import { mkdtemp, writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("ScanIndex", () => {
	test("has returns false for unknown sha1", () => {
		const index = new ScanIndex("/tmp/nonexistent.json")
		expect(index.has("abc123")).toBe(false)
	})

	test("set and has round-trip", () => {
		const index = new ScanIndex("/tmp/nonexistent.json")
		index.set("abc123", { reportPath: "./reports/found/test-1.0.0.json", scannedAt: "2024-01-01T00:00:00Z" })
		expect(index.has("abc123")).toBe(true)
		expect(index.has("other")).toBe(false)
	})

	test("load from file populates data", async () => {
		const dir = await mkdtemp(join(tmpdir(), "scan-index-test-"))
		const indexPath = join(dir, "index.json")
		await writeFile(
			indexPath,
			JSON.stringify({
				abc123: { reportPath: "./reports/found/test-1.0.0.json", scannedAt: "2024-01-01T00:00:00Z" },
			}),
		)

		const index = new ScanIndex(indexPath)
		await index.load()
		expect(index.has("abc123")).toBe(true)
		expect(index.has("def456")).toBe(false)
	})

	test("load from missing file initializes empty", async () => {
		const index = new ScanIndex("/tmp/definitely-missing-index.json")
		await index.load()
		expect(index.has("anything")).toBe(false)
	})

	test("save writes data that can be loaded back", async () => {
		const dir = await mkdtemp(join(tmpdir(), "scan-index-test-"))
		const indexPath = join(dir, "index.json")

		const index = new ScanIndex(indexPath)
		index.set("abc123", { reportPath: "./reports/found/test-1.0.0.json", scannedAt: "2024-01-01T00:00:00Z" })
		await index.save()

		const raw = await readFile(indexPath, "utf-8")
		const parsed = JSON.parse(raw)
		expect(parsed.abc123.reportPath).toBe("./reports/found/test-1.0.0.json")
	})
})
