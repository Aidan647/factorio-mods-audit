export interface ScoreItem {
	score: number // 0-100
	weight: number // 0-100
}

export function calculateScore(items: ScoreItem[]): number {
	let result = 1

	for (const item of items) {
		const score = Math.min(100, Math.max(0, item.score))
		const weight = Math.min(100, Math.max(0, item.weight))

		result *= 1 - (1 - score / 100) * (weight / 100)
	}

	return result * 100
}
