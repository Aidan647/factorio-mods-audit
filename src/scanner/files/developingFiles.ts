import { Glob, JSON5 } from "bun"
import path from "node:path"
import { readFile, readdir } from "node:fs/promises"
import type { AuditSorter, Finding } from "#/findingsSorter"
import { getSize } from "#/helpers/getFolder"

type DevelopingRule = {
	type: string
	description: string
	glob: string
}

type CompiledDevelopingRule = DevelopingRule & {
	matcher: Glob
}

async function loadDevelopingRules(): Promise<CompiledDevelopingRule[]> {
	const cfgPath = process.env.DEVELOPING_RULES_PATH || path.join(process.cwd(), "config/developing-rules.json5")
	const raw = await readFile(cfgPath, "utf-8").catch(() => "{}")
	const parsed = JSON5.parse(raw) as any
	const rulesMap = parsed?.rules ?? {}
	const compiled: CompiledDevelopingRule[] = []
	for (const type of Object.keys(rulesMap)) {
		const arr = Array.isArray(rulesMap[type]) ? rulesMap[type] : []
		for (const item of arr) {
			if (!item || typeof item.glob !== "string") continue
			compiled.push({ type, description: item.description ?? "", glob: item.glob, matcher: new Glob(item.glob) })
		}
	}
	return compiled
}
const compiledRules = await loadDevelopingRules()

export async function findDevelopingFiles(sorter: AuditSorter, basePath: string) {
	const findings = await scanDirectory(basePath, compiledRules)
	// group findings by type and save to report
	const findingsByType: Record<
		string,
		{
			type: string
			description: string
			potetialSavings: number
			paths: string[]
		}
		> = {}
	for (const finding of findings) {
		const type = finding.type
		if (!findingsByType[type]) {
			findingsByType[type] = {
				type,
				description: finding.description,
				potetialSavings: 0,
				paths: [],
			}
		}
		if ((finding as any).potentialSavings) findingsByType[type].potetialSavings += (finding as any).potentialSavings
		if ("path" in finding && (finding as any).path) findingsByType[type].paths.push((finding as any).path)
		if ("paths" in finding && Array.isArray((finding as any).paths)) findingsByType[type].paths.push(...(finding as any).paths)
	}
	for (const type in findingsByType) {
		const finding = findingsByType[type]
		if (!finding) continue
		sorter.addFinding(finding)
	}
}

async function scanDirectory(
	basePath: string,
	compiledRules: CompiledDevelopingRule[],
	currentPath: string = ".",
	findings: Finding[] = [],
): Promise<Finding[]> {
	const pathToScan = path.join(basePath, currentPath)
	const entries = await readdir(pathToScan, { withFileTypes: true }).catch(() => [])
	for (const entry of entries) {
		const entryPath = path.join(pathToScan, entry.name)
		const relativePath = path.relative(basePath, entryPath)
		const matchedRule = matchDevelopingRule(relativePath, entry.name, compiledRules)
		if (matchedRule) {
			findings.push({
				type: matchedRule.type,
				description: matchedRule.description,
				path: relativePath,
				potentialSavings: await getSize(entryPath),
			})
			continue
		}
		if (entry.isDirectory()) {
			await scanDirectory(basePath, compiledRules, relativePath, findings)
		}
	}
	return findings
}

function matchDevelopingRule(relativePath: string, name: string, compiledRules: CompiledDevelopingRule[]): DevelopingRule | null {
	for (const rule of compiledRules) {
		if (rule.matcher.match(relativePath) || rule.matcher.match(name)) return rule
	}
	return null
}
