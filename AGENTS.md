# AGENTS.md

## Project overview

Factorio Mods Audit — downloads Factorio mods from the portal, scans them for malware, clutter, bad images, Lua issues, etc., and produces a scored audit report.

## Runtime & toolchain

- **Bun** (not Node.js). Use `bun` for all commands.
- TypeScript, ESM, strict mode. `package.json` has `"type": "module"`.
- Path alias: `#/*` maps to `./src/*` (tsconfig `paths`). Use it for all internal imports.

## Commands

| Task | Command |
|---|---|
| Type check | `bun typecheck` |
| Format | `bun format` |
| Tests | `bun test` |
| Scan single mod | `bun scan <mod-name> [--json\|--md\|--html\|--txt] [--no-clamav]` |
| Scan top N mods | `bun scan-top <popular\|downloads> <count> [--json\|--md\|--html\|--txt] [--no-clamav]` |
| WebSocket server | `bun serve [--port N] [--host H]` |
| Format report | `bun run tools/format-report.ts` |
| Scan from zip | `bun run tools/scan-zip.ts` |

**Verification order**: `bun typecheck && bun format && bun test`.

## Two tool directories

- `./tools/` — CLI/build scripts run via `bun run tools/<file>` (luacheck binary, format-report, scan-zip)
- `./src/` — Runtime source used by `bun scan`, `bun serve`, etc.

Do not confuse them. Luacheck binary lives at `tools/luacheck`.

## Architecture

```
src/
  cli/            — CLI entry points (scan-command.ts, scan-top-command.ts, server-command.ts)
  modportal/      — Factorio mod portal API client (fetch, download, cache)
  scanner/        — Orchestrator + individual scanners (clutter, images, duplicates, changelog, locale, luacheck, metadata)
  report/         — ReportBuilder, scoring, formatters (txt/md/html)
  server/         — WebSocket server for real-time scanning
  helpers/        — Cache (MemoryCache, DiskCache, MixedCache), rate limiter, scanfile
  config.ts       — ScanConfig loaded from env vars
```

**Scanner pattern**: Each scanner implements the `Scanner` interface from `src/scanner/base.ts` — has `scan()`, `scanFile()`, and `report()` methods. The `Orchestrator` registers all scanners and runs them in sequence. To add a scanner, create a class implementing `Scanner` and register it in `Orchestrator.scanners`.

## Config

Config is env-var driven (see `.env.example`). Key vars:
- `FACTORIO_USERNAME` / `FACTORIO_TOKEN` — portal credentials (required)
- `DATA_DIR` — root data directory (default `./data`)
- `DISABLE_CLAMAV` — skip virus scanning (default `false`)
- `DISABLE_DISK_CACHE` — skip download caching (default `false`)

Rules are JSON5 files in `data/`:
- `clutter-rules.json5` — file pattern rules for clutter detection
- `image-rules.json5` — image size/dimension rules
- `luacheck-codes.json5` — luacheck warning code descriptions

## Conventions

- **Formatting**: Tabs, no semicolons, double quotes, trailing commas (Prettier config in `.prettierrc.json5`)
- **Error handling**: Prefer `await op().catch(() => fallback)` over try-catch. Sync try-catch is acceptable.
- **Types**: Shared types live in `src/types/` or co-located with their module. Avoid `as any`.
- **Tests**: Mirror source structure in `test/` (e.g., `src/scanner/luacheck.ts` → `test/scanner/luacheck.test.ts`). No test files exist yet — you'll be creating the first ones.
- **Imports**: Always use `#/<path>` alias for cross-module imports within src.

## Docker

Dockerfile has multi-stage build. `docker-compose.yml` mounts `./data` and exposes port 3000. ClamAV is disabled by default in Docker.

## Gotchas

- ModPortal has a rate limiter (1 req/5s). Don't hammer the API.
- Luacheck scanner expects `tools/luacheck` binary to exist and be executable.
- Report cache uses zstd compression via `Bun.zstdCompress`/`Bun.zstdDecompress` — Bun-specific APIs.
- `Orchestrator` cleans up temp dirs on construction and after each scan. Don't manually manage `data/cache/tmp/`.
