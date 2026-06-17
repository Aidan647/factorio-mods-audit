import { SUPPORTED_LOCALES } from "#/scanner/helpers/locale"
import { Glob } from "bun"

const matchers: Record<string, { matcher: Glob; matcherException: Glob }> = {
	invalidFolder: {
		matcher: new Glob("locale/*"),
		matcherException: new Glob(`locale/{${Object.keys(SUPPORTED_LOCALES).join(",")}}`),
	},
	otherFiles: {
		matcher: new Glob("locale/**"),
		matcherException: new Glob(`locale/**/*.cfg`),
	},
}

const files = [
	".git",
	"index.html",
	"info.json",
	"locale",
	"locale/notsupported",
	"locale/notsupported/newfile.cfg",
	"locale/fi",
	"locale/fi/test.cfg",
	"locale/fi/newfile.cfg",
	"locale/en",
	"locale/en/test.cfg",
	"locale/en/newfile.cfg",
]

for (const file of files) {
	for (const matcher in matchers) {
		const match = matchers[matcher]
		if (!match) continue
		const isMatch = match.matcher.match(file)
		const isException = match.matcherException.match(file)
		if (isMatch && !isException) {
			console.log(`${file} - Matcher: ${matcher}`)
			break
		}
	}
}
