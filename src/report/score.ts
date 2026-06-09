export interface ScoreItem {
	score: number // 0-100
	weight: number // >0
}


export function calculateScore(
	items: ScoreItem[],
	minShift = 0.01,
	maxShift = 0.75,
): number {
	if (items.length === 0) return 0
	const totalWeight = items.reduce((s, i) => s + i.weight, 0)
	if (totalWeight === 0) return 0

	let result = 1

	for (const item of items) {
		const w = item.weight / totalWeight

		// high weight => smaller shift
		const shift = maxShift - (maxShift - minShift) * w

		const factor = shift + (1 - shift) * (item.score / 100)

		result *= Math.pow(factor, w)
	}

	return Math.max(0, Math.min(100, Math.round(result * 100)))
}
