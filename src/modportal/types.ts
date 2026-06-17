import z from "zod"

export const Release = z.object({
	download_url: z.string(),
	file_name: z.string(),
	info_json: z.object({
		factorio_version: z.string(),
	}),
	released_at: z.string(),
	sha1: z.string(),
	version: z.string(),
})
export type Release = z.infer<typeof Release>

const baseModInfo = z.object({
	category: z.string().nullable(),
	downloads_count: z.number(),
	name: z.string(),
	owner: z.string(),
	score: z.number().default(0),
	summary: z.string(),
	title: z.string(),
})

export const ModInfo = baseModInfo.extend({
	releases: z.array(Release),
	thumbnail: z.string().optional(),
})

export type ModInfo = z.infer<typeof ModInfo>

export const ModListItem = baseModInfo.extend({
	latest_release: Release.nullable(),
})
export type ModListItem = z.infer<typeof ModListItem>

export const ModList = z.object({
	results: z.array(ModListItem),
	pagination: z
		.object({
			count: z.number(),
			page: z.number(),
			page_count: z.number(),
			page_size: z.number(),
		})
		.nullable(),
})
export type ModList = z.infer<typeof ModList>
