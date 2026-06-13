export interface ScoreItem {
	score: number // 0-100
	weight: number // 0-100
}

export function calculateScore(
	items: ScoreItem[],
	minShift = 0, // weight=100 // critical
	maxShift = 0.5, // weight=0
): number {
	let result = 1

	for (const item of items) {
		const score = Math.max(0, Math.min(100, item.score))
		const weight = Math.max(0, Math.min(100, item.weight))

		const normalized = Math.log(1 + weight) / Math.log(101)
		const shift = maxShift - (maxShift - minShift) * normalized

		const deduction = (1 - score / 100) * (1 - shift)

		result *= 1 - deduction
	}

	return result * 100
}
