import type { JsonRpcError } from "./types"
import { ERROR_CODES } from "./types"

export function rpcError(code: number, message: string, data?: unknown): JsonRpcError {
	return { code, message, ...(data !== undefined ? { data } : {}) }
}

export const methodNotFound = (method?: string) =>
	rpcError(ERROR_CODES.METHOD_NOT_FOUND, `Method not found${method ? `: ${method}` : ""}`)

export const invalidParams = (detail: string) => rpcError(ERROR_CODES.INVALID_PARAMS, `Invalid params: ${detail}`)

export const internalError = (err: unknown) =>
	rpcError(ERROR_CODES.INTERNAL_ERROR, err instanceof Error ? err.message : String(err))

export const modNotFound = (modName: string) => rpcError(ERROR_CODES.MOD_NOT_FOUND, `Mod not found: ${modName}`)

export const versionNotFound = (modName: string, version: string) =>
	rpcError(ERROR_CODES.VERSION_NOT_FOUND, `Version ${version} not found for mod ${modName}`)

export const scanFailed = (reason: string) => rpcError(ERROR_CODES.SCAN_FAILED, `Scan failed: ${reason}`)
