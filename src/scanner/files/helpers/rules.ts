export class Rules<T> implements Iterable<T> {
	private readonly rules: T[] = [];

	[Symbol.iterator]() {
		return this.rules[Symbol.iterator]()
	}

	get getRules(): T[] {
		return this.rules
	}

	push(...rule: T[]): this {
		this.rules.push(...rule)
		return this
	}

	unshift(...rule: T[]): this {
		this.rules.unshift(...rule)
		return this
	}

	async loadRules(loader: () => Promise<T[]>): Promise<void> {
		const loaded = await loader().catch(() => [])
		this.rules.push(...loaded)
	}
}
export default Rules
