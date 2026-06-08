import type { ModInfo, ModListItem, Release } from "./types"

/**
 * releaseIndex is the index of the release to use as latest_release. Default is -1 (last release).
 * -2 would be the second to last release, etc.
 */
export function ModInfoToModListItem(modInfo: ModInfo, releaseIndex = -1): ModListItem {
	let latest_release: Release | null = null
	if (releaseIndex < 0) latest_release = modInfo.releases[modInfo.releases.length + releaseIndex] ?? null
	else latest_release = modInfo.releases[releaseIndex] ?? null

	return {
		category: modInfo.category,
		downloads_count: modInfo.downloads_count,
		name: modInfo.name,
		owner: modInfo.owner,
		score: modInfo.score,
		summary: modInfo.summary,
		title: modInfo.title,
		latest_release,
	}
}
