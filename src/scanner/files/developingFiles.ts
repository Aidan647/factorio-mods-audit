import { Glob, JSON5 } from "bun"
import { z } from "zod"
import path from "node:path"
import { readFile, readdir } from "node:fs/promises"
import type { AuditSorter, Finding } from "#/findingsSorter"
import { getSize } from "#/helpers/getFolder"

type ClutterRule = {
	type: string
	description: string
	glob: string
	category?: string
	severity?: "low" | "medium" | "high"
	exceptions?: string[]
}

type CompiledClutterRule = ClutterRule & {
	matcher: Glob
}

async function loadClutterRules(): Promise<CompiledClutterRule[]> {
	const cfgPath = process.env.CLUTTER_RULES_PATH || path.join(process.cwd(), "config/clutter-rules.json5")
	const raw = await readFile(cfgPath, "utf-8").catch(() => "{}")
	const parsed = JSON5.parse(raw) as any
	const compiled: CompiledClutterRule[] = []

	const Schema = z.object({
		rules: z.array(
			z.object({
				type: z.string(),
				description: z.string(),
				globs: z.array(z.string()),
				category: z.string().optional(),
				severity: z.enum(["low", "medium", "high"]).optional(),
				exceptions: z.array(z.string()).optional(),
			}),
		),
	})

	const parsedCfg = Schema.safeParse(parsed)
	if (!parsedCfg.success) {
		console.warn("clutter rules: config validation failed; no rules loaded")
		return compiled
	}

	for (const rule of parsedCfg.data.rules) {
		const type = rule.type
		const description = rule.description
		const category = rule.category
		const severity = rule.severity
		const exceptions = rule.exceptions
		for (const g of rule.globs) {
			compiled.push({
				type,
				description,
				glob: g,
				category,
				severity,
				exceptions,
				matcher: new Glob(g),
			})
		}
	}
	return compiled
}
const compiledRules = await loadClutterRules()

export async function findClutterFiles(sorter: AuditSorter, basePath: string) {
	const findings = await scanDirectory(basePath)
	// group findings by type and save to report
	const findingsByType: Record<
		string,
		{
			type: string
			description: string
			severity?: "low" | "medium" | "high"
			potentialSavings: number
			paths: string[]
		}
	> = {}
	for (const finding of findings) {
		const type = finding.type
		const fin = findingsByType[type] ?? {
			type,
			description: finding.description,
			severity: finding.severity,
			potentialSavings: 0,
			paths: [],
		}
		if (!fin.severity && finding.severity) fin.severity = finding.severity
		if (finding.potentialSavings) fin.potentialSavings += finding.potentialSavings
		if ("path" in finding && finding.path) fin.paths.push(finding.path)
		if ("paths" in finding && Array.isArray(finding.paths)) fin.paths.push(...finding.paths)
		if (!findingsByType[type]) findingsByType[type] = fin
	}
	for (const type in findingsByType) {
		const finding = findingsByType[type]
		if (!finding) continue
		sorter.addFinding(finding)
	}
}

async function scanDirectory(
	basePath: string,
	currentPath: string = ".",
	findings: Finding[] = [],
): Promise<Finding[]> {
	const pathToScan = path.join(basePath, currentPath)
	const entries = await readdir(pathToScan, { withFileTypes: true }).catch(() => [])
	for (const entry of entries) {
		const entryPath = path.join(pathToScan, entry.name)
		const relativePath = path.relative(basePath, entryPath)
		const matchedRule = matchClutterRule(relativePath, entry.name)
		if (matchedRule) {
			findings.push({
				type: `clutter:${matchedRule.type}`,
				description: matchedRule.description,
				severity: matchedRule.severity,
				path: relativePath,
				potentialSavings: await getSize(entryPath),
			})
			continue
		}
		if (entry.isDirectory()) {
			await scanDirectory(basePath, relativePath, findings)
		}
	}
	return findings
}

function matchClutterRule(relativePath: string, name: string): ClutterRule | null {
	for (const rule of compiledRules) {
		if (!rule.matcher.match(relativePath) && !rule.matcher.match(name)) continue
		// skip if path matches any exception glob
		if (rule.exceptions) {
			let excluded = false
			for (const exc of rule.exceptions) {
				if (new Glob(exc).match(relativePath) || new Glob(exc).match(name)) {
					excluded = true
					break
				}
			}
			if (excluded) continue
		}
		return rule
	}
	return null
}
