import type { ScanParams, ScanResult } from "./server/types"

/**
 * Send a scan request over an already-connected WebSocket and await the result.
 * The caller is responsible for creating and closing the WebSocket.
 */
export function scanMod(
	ws: WebSocket,
	modName: string,
	version?: string,
): Promise<ScanResult> {
	const params: ScanParams = { modName, ...(version !== undefined ? { version } : {}) }
	ws.send(JSON.stringify({ jsonrpc: "2.0", method: "scan", params, id: 1 }))

	return new Promise<ScanResult>((resolve, reject) => {
		let settled = false

		ws.addEventListener("message", (event: MessageEvent) => {
			if (settled) return
			settled = true

			try {
				const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as Buffer)
				const msg = JSON.parse(raw)

				if (msg.error) {
					reject(new Error(msg.error.message))
				} else if (msg.result) {
					resolve(msg.result as ScanResult)
				} else {
					reject(new Error("Unexpected JSON-RPC response"))
				}
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)))
			}
		})

		ws.addEventListener("error", () => {
			if (settled) return
			settled = true
			reject(new Error("WebSocket error occurred"))
		})

		ws.addEventListener("close", () => {
			if (settled) return
			settled = true
			reject(new Error("WebSocket closed before receiving response"))
		})
	})
}
