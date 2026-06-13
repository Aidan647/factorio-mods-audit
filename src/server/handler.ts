import z from "zod"
import type { ServerWebSocket } from "bun"
import type { JsonRpcRequest, ScanParams, ScanResult, ServerMethod, TypedResponse } from "./types"
import { methodNotFound, invalidParams, internalError, modNotFound, versionNotFound } from "./errors"
import type { ModPortal } from "../modportal"
import type { ModListItem } from "../modportal/types"
import type { Orchestrator } from "../scanner"

// ── Param schemas ───────────────────────────────────────────────────────

const scanParamsSchema = z.object({
	modName: z.string().min(1),
	version: z.string().min(5),
})

// ── Scan queue (FIFO, serial execution) ─────────────────────────────────

class ScanQueue {
	private chain: Promise<void> = Promise.resolve()

	enqueue<T>(fn: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.chain = this.chain.then(async () => {
				try {
					resolve(await fn())
				} catch (err) {
					reject(err)
				}
			})
		})
	}
}

// ── Message handler ─────────────────────────────────────────────────────

export type HandlerDeps = {
	portal: ModPortal
	orchestrator: Orchestrator
}

export class MessageHandler {
	private readonly queue = new ScanQueue()
	private readonly logEnabled = process.env.WS_LOG === "1" || process.env.WS_LOG?.toLowerCase() === "true"

	private readonly log = (msg: string) => {
		if (this.logEnabled) console.log(`[ws] ${msg}`)
	}

	constructor(private readonly deps: HandlerDeps) {}

	async handle(raw: string, ws: ServerWebSocket<unknown>): Promise<void> {
		let req: JsonRpcRequest
		try {
			req = JSON.parse(raw) as JsonRpcRequest
		} catch {
			this.send(ws, { jsonrpc: "2.0", error: invalidParams("Failed to parse JSON"), id: null })
			return
		}

		if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
			this.send(ws, { jsonrpc: "2.0", error: invalidParams("Missing jsonrpc or method field"), id: req.id ?? null })
			return
		}

		switch (req.method as ServerMethod) {
			case "ping":
				await this.handlePing(ws, req)
				break
			case "scan":
				await this.handleScan(ws, req)
				break
			default:
				this.send(ws, { jsonrpc: "2.0", error: methodNotFound(req.method), id: req.id ?? null })
		}
	}

	private async handlePing(ws: ServerWebSocket<unknown>, req: JsonRpcRequest): Promise<void> {
		this.send(ws, { jsonrpc: "2.0", result: { pong: true, timestamp: Date.now() }, id: req.id })
	}

	private async handleScan(ws: ServerWebSocket<unknown>, req: JsonRpcRequest): Promise<void> {
		const parsed = scanParamsSchema.safeParse(req.params)
		if (!parsed.success) {
			this.send(ws, { jsonrpc: "2.0", error: invalidParams(parsed.error.message), id: req.id })
			return
		}

		const params = parsed.data as ScanParams
		this.log(`scan request: ${params.modName}@${params.version}`)

		// Queue the scan — runs serially with other scans
		const result = await this.queue.enqueue(async (): Promise<
			{ kind: "data"; data: ScanResult } | { kind: "error"; error: Error }
		> => {
			this.log(`starting scan: ${params.modName}@${params.version}`)
			try {
				return await this.runScan(params)
			} catch (err) {
				return { kind: "error", error: err instanceof Error ? err : new Error(String(err)) }
			}
		})

		if (result.kind === "error") {
			this.log(`scan failed: ${params.modName}@${params.version} — ${result.error.message}`)
			this.send(ws, { jsonrpc: "2.0", error: internalError(result.error), id: req.id })
			return
		}

		this.log(`scan complete: ${params.modName}@${params.version}`)
		this.send<"scan">(ws, { jsonrpc: "2.0", result: result.data, id: req.id })
	}

	private async runScan(
		params: ScanParams,
	): Promise<{ kind: "data"; data: ScanResult } | { kind: "error"; error: Error }> {
		const modInfo = await this.deps.portal.getModInfo(params.modName).catch(() => null)
		if (!modInfo) return { kind: "error", error: new Error(modNotFound(params.modName).message) }

		const release = modInfo.releases.find((r) => r.version === params.version)
		if (!release)
			return { kind: "error", error: new Error(versionNotFound(params.modName, params.version).message) }

		const modListItem: ModListItem = {
			category: modInfo.category,
			downloads_count: modInfo.downloads_count,
			name: modInfo.name,
			owner: modInfo.owner,
			score: modInfo.score,
			summary: modInfo.summary,
			title: modInfo.title,
			latest_release: release,
		}

		const report = await this.deps.orchestrator.scanMod(modListItem)
		if (!report) return { kind: "error", error: new Error("Scan returned no report") }

		return { kind: "data", data: { report, modInfo: modListItem } }
	}

	private send<M extends ServerMethod>(ws: ServerWebSocket<unknown>, msg: TypedResponse<M>): void {
		ws.send(JSON.stringify(msg))
	}
}
