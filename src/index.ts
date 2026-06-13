// Library entry — export public API
export { scanSingleMod } from "./cli"
export { default as ModPortal, type ModPortalConfig } from "./modportal"
export { Orchestrator } from "./scanner"
export { ReportBuilder, type AuditReport, type Finding, type ScannerReport } from "./report"
export { formatTxt, formatMd, formatHtml } from "./report/formatters"
export { loadConfig, defaultConfig, type ScanConfig } from "./config"
export type { ModListItem, ModInfo, Release } from "./modportal/types"
export type { Scanner, ScannerResult } from "./scanner/base"
export { createServer, type WebSocketServerOptions } from "./server"
export type * from "./server/types"

