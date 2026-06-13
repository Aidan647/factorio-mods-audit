export function bytesToHuman(bytes: number, significance: 1 | 2 | 3 | 4 = 3): string {
	if (bytes < 1024) return `${bytes} B`
	const units = ["B", "kiB", "MiB", "GiB", "TiB"]
	const exponent = Math.floor(Math.log(bytes) / Math.log(1024))
	const value = bytes / Math.pow(1024, exponent)
	const digits = Math.max(0, significance - Math.floor(Math.log10(value)) - 1)
	return `${value.toFixed(digits)} ${units[exponent]}`
}
export function numberToHuman(num: number): string {
	if (num < 1000) return `${num}`
	const units = ["", "k", "M", "B", "T"]
	const exponent = Math.floor(Math.log(num) / Math.log(1000))
	const value = num / Math.pow(1000, exponent)
	const digits = Math.max(0, 3 - Math.floor(Math.log10(value)))
	return `${value.toFixed(digits)}${units[exponent]}`
}
