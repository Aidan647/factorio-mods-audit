import { readFile } from "node:fs/promises"
import path from "node:path"
import sharp from "sharp"
import type { Sharp, PngOptions } from "sharp"
import type { CompiledImageRule } from "./image-rules"
import type { FileEntry } from "#/scanner/walkDir"

export type ImageFinding = {
	type: string
	description: string
	severity: "low" | "medium" | "high"
	path: string
	potentialSavings: number
}

/**
 * Load a PNG file and extract image info.
 */
export async function loadImage(fileEntry: FileEntry): Promise<[Sharp, number] | null> {
	const buffer = await fileEntry.read().catch(() => null)
	if (!buffer) return null

	const img = sharp(buffer)
	const metadata = await img.metadata().catch(() => null)
	if (!metadata || metadata.width === 0 || metadata.height === 0) return null

	return [img, buffer.byteLength]
}

function maxDimension(size: { width: number; height: number }, mipmaps: number = 0): { width: number; height: number } {
	if (mipmaps <= 0) return size
	// Calculate the maximum dimension of the base image given the number of mipmaps
	// Each mipmap level increases the total width by previous level's width
	// 64px base + 32 + 16 + 8 = 120px total width for 3 mipmaps
	let totalWidth = size.width
	let currentWidth = size.width
	for (let i = 0; i < mipmaps; i++) {
		currentWidth = Math.ceil(currentWidth / 2) // round up just in case of odd dimensions
		totalWidth += currentWidth
	}

	return { width: totalWidth, height: size.height }
}

/**
 * Check if image dimensions exceed the rule's optimal or max thresholds.
 * Returns findings for optimal (warning) and max (violation).
 * For max violations, computes potential savings by resizing + recompression.
 */
export async function checkImage(
	image: Sharp,
	size: number,
	imagePath: string,
	rule: CompiledImageRule,
): Promise<ImageFinding | null> {
	const metadata = await image.metadata()
	const w = metadata.width ?? 0
	const h = metadata.height ?? 0

	// Check max dimensions — hard violation with savings estimate
	if (rule.maxSize) {
		const { width: maxWidth, height: maxHeight } = maxDimension(rule.maxSize, rule.maxMipmaps)
		if (w > maxWidth || h > maxHeight) {
			const { width: optimalWidth, height: optimalHeight } = rule.optimalSize || rule.maxSize
			const potentialSavings = await computeResizeSavings({ img: image, fileSize: size }, maxWidth, maxHeight)
			if (potentialSavings <= 0) return null
			return {
				type: `images:${rule.type}`,
				description: `Image dimensions${rule.optimalSize ? " higly" : ""} exceed optimal dimensions are ${optimalWidth}x${optimalHeight}.`,
				severity: rule.severity,
				path: imagePath,
				potentialSavings,
			}
		}
	}

	const potentialSavings = await computeResizeSavings({ img: image, fileSize: size })
	// add finding only if it has potential savings more than 5% + 100 bytes of the original size to avoid noise
	if (potentialSavings > size * 0.05 + 100) {
		return {
			type: `images:compression`,
			description: `Image has potential for better compression.`,
			severity: "low",
			path: imagePath,
			potentialSavings,
		}
	}

	return null
}

async function computeResizeSavings(imageInfo: { img: Sharp; fileSize: number }): Promise<number>
async function computeResizeSavings(
	imageInfo: { img: Sharp; fileSize: number },
	maxWidth: number,
	maxHeight: number,
): Promise<number>
async function computeResizeSavings(
	imageInfo: { img: Sharp; fileSize: number },
	maxWidth?: number,
	maxHeight?: number,
): Promise<number> {
	const { img, fileSize } = imageInfo
	const options: PngOptions = { compressionLevel: 9 }
	const metadata = await img.metadata()
	if (metadata.isPalette) {
		options.palette = true
		options.effort = 10
		options.colors = Math.pow(2, metadata.bitsPerSample ?? 8)
	}

	if (maxWidth !== undefined && maxHeight !== undefined) {
		const width = metadata.width ?? 0
		const height = metadata.height ?? 0
		if (width <= maxWidth && height <= maxHeight) {
			const buffer = await img.png(options).toBuffer()
			return fileSize - buffer.byteLength
		}
	}

	const buffer = await img.png(options).toBuffer()
	return fileSize - buffer.byteLength
}
