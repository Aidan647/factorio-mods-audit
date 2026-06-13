#!/usr/bin/env bun
/**
 * `bun serve` — Start the WebSocket server.
 *
 * Usage:
 *   bun serve                    (default: port 8080)
 *   bun serve --port 3000
 *   bun serve --port 3000 --host 0.0.0.0
 */
import ModPortal, { type ModPortalConfig } from "../modportal"
import Orchestrator from "../scanner"
import { loadConfig, type ScanConfig } from "../config"
import { createServer } from "../server"

const config = loadConfig()

const args = process.argv.slice(2)

const portIndex = args.indexOf("--port")
const port = portIndex !== -1 ? Number(args[portIndex + 1]) : config.serverPort

const hostIndex = args.indexOf("--host")
const host = hostIndex !== -1 ? args[hostIndex + 1] : config.serverHost

if (Number.isNaN(port)) {
	console.error("Usage: bun serve [--port <number>] [--host <string>]")
	process.exit(1)
}

const portalConfig: ModPortalConfig = {
	username: process.env.FACTORIO_USERNAME || process.env.USERNAME || "username",
	token: process.env.FACTORIO_TOKEN || process.env.TOKEN || "token",
	disableDiskCache: config.disableDiskCache,
	disableClamAv: config.disableClamAv,
	cacheExpiryMs: config.cacheExpiryMs,
}
const portal = new ModPortal(portalConfig)
await portal.tokenValidation // Ensure token is valid before accepting connections

const orchestrator = new Orchestrator(portal, config)
await orchestrator.loadIndex()
const server = createServer({ port, host, portal, orchestrator })

console.log(`WebSocket server listening on ws://${host ?? "localhost"}:${port}/`)
console.log("Press Ctrl+C to stop")

// Prevent the process from exiting
await new Promise(() => {})
