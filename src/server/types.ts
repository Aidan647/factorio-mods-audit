import type { AuditReport } from "../report"
import type { ModListItem } from "../modportal/types"

// ── JSON-RPC 2.0 envelope types ──────────────────────────────────────────

export type JsonRpcId = string | number | null

export type JsonRpcRequest = {
	jsonrpc: "2.0"
	method: string
	params?: unknown
	id: JsonRpcId
}

export type JsonRpcResponse<T = unknown> = {
	jsonrpc: "2.0"
	result?: T
	error?: JsonRpcError
	id: JsonRpcId
}

export type JsonRpcError = {
	code: number
	message: string
	data?: unknown
}

export type JsonRpcNotification = {
	jsonrpc: "2.0"
	method: string
	params?: unknown
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

// ── JSON-RPC error codes ──────────────────────────────────────────────────

export const ERROR_CODES = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
	MOD_NOT_FOUND: -32001,
	VERSION_NOT_FOUND: -32002,
	SCAN_FAILED: -32003,
} as const

// ── Method-specific types ─────────────────────────────────────────────────

export type ServerMethod = "scan" | "ping" | "queue_length"

export type ScanParams = {
	modName: string
	version?: string
}

export type ScanResult = {
	report: AuditReport
	modInfo: ModListItem
}

export type PingParams = void

export type PingResult = {
	pong: true
	timestamp: number
}

// ── Type-safe method map ─────────────────────────────────────────────────

export type QueueLengthParams = void

export type QueueLengthResult = {
	length: number
}

export type MethodMap = {
	scan: { params: ScanParams; result: ScanResult }
	ping: { params: PingParams; result: PingResult }
	queue_length: { params: QueueLengthParams; result: QueueLengthResult }
}

export type TypedRequest<M extends ServerMethod> = JsonRpcRequest & {
	method: M
	params: MethodMap[M]["params"]
}

export type TypedResponse<M extends ServerMethod> = JsonRpcResponse<MethodMap[M]["result"]>
