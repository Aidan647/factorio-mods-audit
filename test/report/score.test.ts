import { describe, expect, test } from "bun:test"
import { calculateScore } from "../../src/report/score"

describe("calculateScore", () => {
	test("returns 0 for empty items", () => {
		expect(calculateScore([])).toBe(0)
	})

	test("returns 0 when total weight is 0", () => {
		expect(calculateScore([{ score: 100, weight: 0 }])).toBe(0)
	})

	test("returns 100 for a single perfect item", () => {
		expect(calculateScore([{ score: 100, weight: 50 }])).toBe(100)
	})

	test("returns floor for a single zero-score item", () => {
		expect(calculateScore([{ score: 0, weight: 50 }])).toBe(1)
	})

	test("two perfect items returns 100", () => {
		expect(calculateScore([{ score: 100, weight: 1 }, { score: 100, weight: 1 }])).toBe(100)
	})

	test("two zero-score items returns floor value", () => {
		const result = calculateScore([{ score: 0, weight: 1 }, { score: 0, weight: 1 }])
		expect(result).toBeGreaterThan(0)
		expect(result).toBeLessThan(50)
	})

	test("one perfect, one zero with equal weights", () => {
		const result = calculateScore([{ score: 100, weight: 1 }, { score: 0, weight: 1 }])
		expect(result).toBe(62)
	})

	test("low-weight zero item doesn't kill score", () => {
		const result = calculateScore([{ score: 100, weight: 90 }, { score: 0, weight: 10 }])
		expect(result).toBe(96)
	})

	test("high-weight zero item drags score down", () => {
		const result = calculateScore([{ score: 100, weight: 10 }, { score: 0, weight: 90 }])
		expect(result).toBe(11)
	})

	test("three items with mixed scores", () => {
		const result = calculateScore([
			{ score: 90, weight: 30 },
			{ score: 50, weight: 40 },
			{ score: 20, weight: 30 },
		])
		expect(result).toBeGreaterThan(0)
		expect(result).toBeLessThan(100)
	})

	test("all items at same score with equal weights", () => {
		const two = calculateScore([{ score: 50, weight: 1 }, { score: 50, weight: 1 }])
		const three = calculateScore([{ score: 50, weight: 1 }, { score: 50, weight: 1 }, { score: 50, weight: 1 }])
		expect(two).toBeGreaterThan(50)
		expect(two).toBeLessThan(100)
		expect(three).toBeGreaterThan(50)
		expect(three).toBeLessThan(100)
	})

	test("all items at 75 with equal weights", () => {
		const two = calculateScore([{ score: 75, weight: 1 }, { score: 75, weight: 1 }])
		const three = calculateScore([{ score: 75, weight: 1 }, { score: 75, weight: 1 }, { score: 75, weight: 1 }])
		expect(two).toBeGreaterThan(75)
		expect(two).toBeLessThan(100)
		expect(three).toBeGreaterThan(75)
		expect(three).toBeLessThan(100)
	})

	test("clamps negative scores to 0", () => {
		const result = calculateScore([{ score: -10, weight: 50 }])
		expect(result).toBeGreaterThanOrEqual(0)
	})

	test("clamps scores above 100 to 100", () => {
		expect(calculateScore([{ score: 150, weight: 50 }])).toBe(100)
	})

	test("custom minShift and maxShift", () => {
		const result = calculateScore([{ score: 0, weight: 50 }], 0.5, 0.5)
		expect(result).toBe(50)
	})

	test("minShift > maxShift is handled gracefully", () => {
		// Should still produce a result without throwing
		const result = calculateScore([{ score: 100, weight: 50 }], 0.9, 0.1)
		expect(result).toBe(100)
	})
})
