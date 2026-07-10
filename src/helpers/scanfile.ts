import { mkdir, rm, writeFile } from "node:fs/promises"

export const Verdict = {
	Clean: "Clean",
	Malicious: "Malicious",
	ScanError: "ScanError",
} as const
type VerdictValue = (typeof Verdict)[keyof typeof Verdict]

export async function scanFile(path: string): Promise<VerdictValue> {
	const scan = Bun.spawn(["clamdscan", "--no-summary", "--fdpass", path])
	await scan.exited
	const output = await scan.stdout.text()
	// /tmp/fma-scan-019ea4f0-9db0-7000-ab14-4dc9578f0da8: Eicar-Signature FOUND
	// or
	// /tmp/fma-scan-019ea4f0-9db0-7000-ab14-4dc9578f0da8: OK
	if (output.includes("FOUND")) {
		return Verdict.Malicious
	} else if (output.includes("OK")) {
		return Verdict.Clean
	} else {
		console.log("Unexpected clamd output:", output)
		return Verdict.ScanError
	}
}
await mkdir("/tmp/fma-scan", { recursive: true }).catch((err) => {
	console.log("Error creating temp scan directory:", err)
})
process.on("beforeExit", () => {
	rm("/tmp/fma-scan", { recursive: true, force: true }).catch((err) => {
		console.log("Error cleaning up temp scan directory:", err)
	})
})

export function scanBuffer(buffer: Buffer): Promise<VerdictValue> {
	// write file to /tmp/ with random name, then scan it, then delete it
	const tempPath = `/tmp/fma-scan/${Bun.randomUUIDv7()}`
	return writeFile(tempPath, buffer)
		.then(() => scanFile(tempPath))
		.finally(() => {
			rm(tempPath, { force: true }).catch((err) => {
				console.log(`Error deleting temp file ${tempPath}:`, err)
			})
		})
}
