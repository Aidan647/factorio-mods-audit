import z from "zod"
import path from "node:path"
import type { AuditSorter } from "../findingsSorter"
import { readdir, readFile } from "node:fs/promises"

const versionFormat = z.stringFormat("versionFormat", (value) => {
	const split = value.split(".")
	if (split.length !== 3) return false
	for (const part of split) {
		const num = Number(part)
		if (isNaN(num)) return false
		if (!Number.isInteger(num)) return false
		if (num < 0) return false
		if (num > 65535) return false
	}
	return true
})
const factorioVersions = z.stringFormat("factorioVersionFormat", (value) => {
	const split = value.split(".")
	if (split.length !== 2) return false
	const num1 = Number(split[0])
	const num2 = Number(split[1])
	if (isNaN(num1) || isNaN(num2)) return false
	if (num1 === 0) if (num2 >= 12 && num2 <= 18) return true
	if (num1 === 1) if (num2 >= 0 && num2 <= 1) return true
	if (num1 === 2) if (num2 >= 0 && num2 <= 1) return true
	return false
})
const infoJsonSchema = z.object({
	name: z
		.string()
		.min(3)
		.max(50)
		.regex(/^[0-9a-zA-Z\-_ ]+$/),
	version: versionFormat,
	title: z.string().max(100),
	author: z.union([z.string(), z.array(z.string())]),
	contact: z.string().optional(),
	homepage: z.string().optional(),
	description: z.string().optional(),
	factorio_version: factorioVersions.default("0.12"),
	dependencies: z.array(z.string()).default([]),
	quality_required: z.boolean().default(false),
	rail_bridges_required: z.boolean().default(false),
	spoiling_required: z.boolean().default(false),
	freezing_required: z.boolean().default(false),
	segmented_units_required: z.boolean().default(false),
	expansion_shaders_required: z.boolean().default(false),
	space_travel_required: z.boolean().default(false),
})
type InfoJson = z.infer<typeof infoJsonSchema>

/**
 * Detect folder path modiname_version or modname,
 * scans the info.json for any malicious content, and returns the mod name and version.
 */
export async function analyzeInfoJson(sorter: AuditSorter): Promise<string | null> {
	const folderPath = await scanForFolder(sorter)
	if (!folderPath) return null
	const infoJsonPath = path.join(folderPath, "info.json")
	await validateInfoJson(infoJsonPath, sorter)
	return folderPath
}

async function validateInfoJson(infoJsonPath: string, sorter: AuditSorter): Promise<boolean> {
	const data = JSON.parse((await readFile(infoJsonPath, "utf-8").catch(() => "{}")) || "{}")
	const result = infoJsonSchema.safeParse(data)
	if (!result.success) {
		sorter.addFinding({
			type: "InvalidInfoJson",
			description: z.prettifyError(result.error),
		})
		return false
	}

	for (const dep of result.data.dependencies) {
		const regex = /^(?:(?:!|\?|\(\?\)|~) ?)?(?:[0-9a-zA-Z\-_ ]+)(?: (?:<=|>=|=|<|>) ?\d+(?:\.\d+(?:\.\d+)?)?)?$/
		if (!regex.test(dep)) {
			sorter.addFinding({
				type: "InvalidDependency",
				description: `The mod has an invalid dependency format: "${dep}".`,
			})
		}
	}
	return true
}

async function scanForFolder(sorter: AuditSorter): Promise<string | null> {
	const basePath = path.join("./cache/tmp", `${sorter.modName}-${sorter.version}/`)
	const files = await readdir(basePath, { withFileTypes: true })
	const results: string[] = []
	const unexpectedPaths: string[] = []
	for (const file of files) {
		if (!file.isDirectory()) {
			unexpectedPaths.push(file.name)
			continue
		}
		const valid = await folderHasValidInfoJson(path.join(basePath, file.name), sorter)
		if (valid) {
			results.push(path.join(basePath, file.name))
		} else {
			unexpectedPaths.push(file.name)
		}
	}
	if (unexpectedPaths.length > 0) {
		sorter.addFinding({
			type: "UnexpectedPaths",
			description: "The mod contains unexpected folders in the root directory.",
			paths: unexpectedPaths,
		})
	}
	if (results.length === 0) {
		sorter.addFinding({
			type: "MissingInfoJson",
			description: "The mod does not contain a folder with a valid info.json file.",
		})
		return null
	}
	if (results.length > 1) {
		sorter.addFinding({
			type: "MultipleInfoJson",
			description: "The mod contains multiple folders with valid info.json files.",
			paths: results,
		})
		return null
	}
	return results[0]!
}

async function folderHasValidInfoJson(folderPath: string, sorter: AuditSorter): Promise<boolean> {
	const infoJsonPath = path.join(folderPath, "info.json")
	const data = JSON.parse((await readFile(infoJsonPath, "utf-8").catch(() => "{}")) || "{}")
	if (!data.name || !data.version) {
		return false
	}
	if (data.name !== sorter.modName || data.version !== sorter.version) {
		sorter.addFinding({
			type: "MismatchedInfoJson",
			description:
				"The mod contains an info.json file, but the name or version does not match the expected values.",
			path: infoJsonPath,
		})
		return false
	}
	return true
}
