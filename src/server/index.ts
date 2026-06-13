import type { ServerWebSocket } from "bun"
import type { ModPortal } from "../modportal"
import type { Orchestrator } from "../scanner"
import { MessageHandler } from "./handler"

export type WebSocketServerOptions = {
	port: number
	host?: string
	orchestrator: Orchestrator
	portal: ModPortal
}

export function createServer(opts: WebSocketServerOptions) {
	const handler = new MessageHandler({ portal: opts.portal, orchestrator: opts.orchestrator })

	return Bun.serve({
		port: opts.port,
		hostname: opts.host ?? "localhost",
		fetch(req, server) {
			if (server.upgrade(req)) {
				return
			}
			return new Response("Not found", { status: 404 })
		},
		websocket: {
			async message(ws: ServerWebSocket, data: string | Buffer) {
				const raw = typeof data === "string" ? data : new TextDecoder().decode(data)
				await handler.handle(raw, ws)
			},
			open(_ws) {
				// Connection opened — no action needed
			},
			close(_ws) {
				// Connection closed — no cleanup needed
			},
			drain(_ws) {
				// Backpressure — no action needed
			},
		},
	})
}
