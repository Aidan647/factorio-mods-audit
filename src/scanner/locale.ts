import path from "node:path"
import { Glob } from "bun"
import { readdir, readFile } from "node:fs/promises"
import type { Scanner, ScannerResult } from "./base"
import type { Finding, ReportBuilder } from "../report"
import { ClutterScanner } from "./files"
import { SUPPORTED_LOCALES } from "./helpers/locale"
import type { PathEntry } from "./walkDir"

export class LocaleScanner implements Scanner {
	readonly id = "locale"
	readonly weight = 30
	readonly minimumImpact: number = 60
	readonly findings: Finding[] = []
	// language code (e.g. "en") => { key: string; value: string; file: string; line: number }
	readonly locales: Map<string, Record<string, { value: string; file: string; line: number }[]>> = new Map()

	static loaded = false
	// locale — Can contain up to one subfolder per language, identified with the language code, for example en for English.
	// The subfolder then has to contain at least one *.cfg file which defines the translations for that language.
	static async load(): Promise<void> {
		if (!ClutterScanner.loaded) await ClutterScanner.load()
		if (!ClutterScanner.loaded) return console.warn("LocaleScanner: failed to load clutter rules.")
		ClutterScanner.rules.push(
			{
				type: "clutter:invalidLocaleFolder",
				description: `Locale subfolders must be one of the valid language codes (e.g. "en", "fr").`,
				category: "locale",
				severity: "low",
				matchers: [new Glob("locale/*")],
				matcherExceptions: [
					new Glob(`locale/{${Object.keys(SUPPORTED_LOCALES).join(",")}}`),
					new Glob("locale/**.lua"),
				],
			},
			{
				type: "clutter:cfgOnly",
				description: "Locale folders should contain only .cfg files.",
				category: "locale",
				severity: "low",
				matchers: [new Glob("locale/*/**")],
				matcherExceptions: [new Glob(`locale/**/*.cfg`), new Glob("locale/**/*.lua")],
			},
			{
				type: "clutter:cfg",
				description: "Locale .cfg files should be directly inside the locale folders.",
				category: "locale",
				severity: "low",
				matchers: [new Glob("*.cfg")],
				matcherExceptions: [new Glob(`locale/**/*.cfg`)],
			},
		)
		LocaleScanner.loaded = ClutterScanner.loaded
	}

	async scanFile(modPath: string, sorter: ReportBuilder, fileEntry: PathEntry): Promise<void> {
		if (fileEntry.isDirectory) return
		if (!fileEntry.relativePath.startsWith("locale/") || !fileEntry.relativePath.endsWith(".cfg")) return
		const locale = this.identifyLocale(fileEntry.relativePath)
		if (!locale) return
		const content = await fileEntry.read().then((buf) => buf.toString())
		if (content === "") {
			this.findings.push({
				type: "emptyLocaleFile",
				description: "The locale file contains no translations.",
				severity: "medium",
				paths: [fileEntry.relativePath],
			})
			return
		}
		const localeData = this.parseLocaleFile(content, fileEntry.relativePath)
		for (const { key, value, line } of localeData) {
			if (!this.locales.has(locale)) {
				this.locales.set(locale, {})
			}
			const existing = this.locales.get(locale)!
			if (!existing[key]) {
				existing[key] = []
			}
			existing[key].push({ value, file: fileEntry.relativePath, line })
		}
	}

	identifyLocale(relativePath: string): string | null {
		const parts = relativePath.split(path.sep)
		if (parts.length < 3 || parts[0] !== "locale") return null
		const locale = parts[1]
		if (!locale) return null
		if (!SUPPORTED_LOCALES[locale]) return null
		return locale
	}
	parseLocaleFile(content: string, filePath: string) {
		const lines = content.replaceAll("\r\n", "\n").split("\n")
		const result: { key: string; value: string; line: number }[] = []
		let category = ""
		let emptyCategory = false
		let hasAKey = false

		for (let l = 0; l < lines.length; l++) {
			const line = lines[l]
			if (line === undefined) continue
			const trimmed = line.trim()
			if (trimmed.startsWith("#") || trimmed.startsWith(";") || trimmed === "") {
				continue
			}

			const categoryName = this.parseCategory(trimmed, filePath, l + 1)
			if (typeof categoryName === "string") {
				if (emptyCategory) {
					this.findings.push({
						type: "emptyCategory",
						description: "The locale file contains an empty category with no key-value pairs.",
						severity: "low",
						potentialSavings: categoryName.length + 3, // +3 for the brackets and newline
						paths: [`${filePath}:${l} ([${category}])`],
					})
				}
				category = categoryName
				emptyCategory = true
				continue
			} else if (categoryName) {
				continue
			}
			const keyValue = this.parseKeyValue(line, filePath, l + 1, category)
			if (keyValue === null) continue
			const key = category ? `${category}.${keyValue[0]}` : keyValue[0]
			result.push({ key, value: keyValue[1], line: l + 1 })
			emptyCategory = false
			hasAKey = true
		}

		if (!hasAKey) {
			this.findings.push({
				type: "emptyLocaleFile",
				description: "The locale file contains no translations.",
				severity: "medium",
				potentialSavings: content.length,
				paths: [filePath],
			})
		}
		return result
	}

	/**
	 * retuns true if need to skip scanning this line
	 */
	parseCategory(trimmed: string, filePath: string, l: number): string | boolean {
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			const categoryName = trimmed.slice(1, -1)
			if (!categoryName.trim()) {
				this.findings.push({
					type: "emptyCategoryName",
					description: "The locale file contains an empty category name.",
					severity: "medium",
					potentialSavings: categoryName.length + 3, // +2 for the brackets and newline
					paths: [`${filePath}:${l}`],
				})
				return true
			}
			if (categoryName !== categoryName.trim()) {
				this.findings.push({
					type: "categoryWhitespace",
					description: "The category name contains leading or trailing whitespace.",
					severity: "high",
					potentialSavings: categoryName.length - categoryName.trim().length,
					paths: [`${filePath}:${l} ([${categoryName}])`],
				})
			}
			return categoryName
		}
		return false
	}

	parseKeyValue(line: string, filePath: string, l: number, category?: string): [string, string] | null {
		const equalIndex = line.indexOf("=")
		if (equalIndex === -1) {
			this.findings.push({
				type: "invalidKeyValue",
				description: "The line does not contain an equal sign separating key and value.",
				severity: "high",
				potentialSavings: line.length + 1, // +1 for the newline
				paths: [`${filePath}:${l}`],
			})
			return null
		}
		const key = line.slice(0, equalIndex)
		const value = line.slice(equalIndex + 1)
		if (!key.trim()) {
			this.findings.push({
				type: "emptyKey",
				description: "The line contains an empty key.",
				severity: "high",
				paths: [`${filePath}:${l}`],
			})
			return null
		}
		const cat = category ? `${category}.${key}` : key
		if (key !== key.trim()) {
			this.findings.push({
				type: "keyWhitespace",
				description: "The key contains leading or trailing whitespace.",
				severity: "high",
				potentialSavings: key.length - key.trim().length,
				paths: [`${filePath}:${l} (${cat})`],
			})
		}
		if (value.trim() === "") {
			this.findings.push({
				type: "emptyValue",
				description: "The line contains an empty value.",
				severity: "medium",
				potentialSavings: key.length + 2, // +2 for the equal sign and newline
				paths: [`${filePath}:${l} (${cat})`],
			})
			return null
		}
		if (value !== value.trim()) {
			this.findings.push({
				type: "valueWhitespace",
				description: "The value contains leading or trailing whitespace.",
				severity: "medium",
				potentialSavings: value.length - value.trim().length,
				paths: [`${filePath}:${l} (${cat})`],
			})
		}
		return [key, value]
	}

	report(_modPath: string, _sorter: ReportBuilder): ScannerResult {
		const english = this.locales.get("en") || {}
		for (const [locale, entries] of this.locales) {
			for (const key in entries) {
				const existing = entries[key]
				if (!existing) continue
				if (existing.length > 1) {
					const potentialSavings = (existing.length - 1) * (key.length + (existing[0]?.value.length ?? 0) + 2)
					this.findings.push({
						type: "duplicateKey",
						description: `The locale file contains duplicate keys with the same name.`,
						severity: "medium",
						potentialSavings, // +1 for the equal sign
						paths: existing.map((e) => `${e.file}:${e.line} (${key})`),
					})
				}
				if (existing[0]?.value === undefined) continue
				if (locale !== "en" && english[key]?.[0]?.value === existing[0].value) {
					const potentialSavings = key.length + existing[0].value.length + 2
					this.findings.push({
						type: "untranslatedValue",
						description: `The translation is identical to the English version, which may indicate an untranslated string.`,
						severity: "low",
						potentialSavings,
						paths: existing.map((e) => `${e.file}:${e.line} (${key})`),
					})
				}
			}
		}
		const [mergedFindings, deductions, savings] = this.groupByCategory(this.findings)

		const score = 100 * (500 / (500 + deductions))
		return {
			id: this.id,
			score: score,
			weight: this.weight,
			savings,
			findings: mergedFindings,
			minimumImpact: this.minimumImpact,
		}
	}

	groupByCategory(findings: Finding[]): [Finding[], scoresum: number, savingssum: number] {
		// group findings by id
		const grouped: Map<string, Finding[]> = new Map()
		for (const finding of findings) {
			const existing = grouped.get(finding.type)
			if (existing) existing.push(finding)
			else grouped.set(finding.type, [finding])
		}
		// merge findings in the same group
		const merged: Finding[] = []
		let scoresum = 0
		let savingssum = 0
		for (const [_, group] of grouped) {
			const first = group[0]
			if (!first) continue
			if (group.length === 1) {
				merged.push(first)
				continue
			}
			const mergedFinding: Finding = {
				type: first.type,
				description: first.description,
				severity: first.severity,
				paths: group.flatMap((f) => f.paths).filter((p) => p !== undefined),
				potentialSavings: group.reduce((sum, f) => sum + (f.potentialSavings ?? 0), 0),
			}
			savingssum += mergedFinding.potentialSavings ?? 0
			merged.push(mergedFinding)
			if (mergedFinding.paths) {
				const pathCount = mergedFinding.paths.length
				if (mergedFinding.severity === "low") scoresum += 1 * pathCount
				else if (mergedFinding.severity === "medium") scoresum += 2 * pathCount
				else if (mergedFinding.severity === "high") scoresum += 5 * pathCount
			}
		}
		scoresum += savingssum
		return [merged, scoresum, savingssum]
	}
}
