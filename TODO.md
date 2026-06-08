# TODO — Factorio Mods Audit

> Project: download a Factorio mod, scan for malware, unzip, analyze contents.

## Short-term

- [ ] **Factorio API client** — fetch mod metadata + download zip from `mods.factorio.com/api/mods`
- [ ] **Zip extraction** — unzip mod file in-memory or to temp dir
- [ ] **Malware scan** — check for PE/ELF headers, high-entropy (packed) blobs
- [ ] **PNG analysis** — compression ratio vs raw pixel data; flag unnecessary chunks (`tEXt`, `iTXt`, `zTXt`)
- [ ] **Structure analysis** — detect `.git/`, `node_modules/`, `.DS_Store`, `.exe`, `.dll`, oversized files
- [ ] **Scoring system** — start at 100, deduct per finding
- [ ] **Report output** — text + JSON formats, save to `.audit/reports/`
- [ ] **CLI arg parsing** — `--mod`, `--json`, `--no-cleanup`, `--output`
- [ ] **Config file** — JSON5 config for API URL, thresholds, ignore patterns
- [ ] **README** — project overview, usage, architecture

## Analysis improvements

- [ ] **Lua linting** — parse `.lua` files for suspicious patterns (`os.execute`, `require` with raw paths)
- [ ] **Locale completeness** — check that all locale keys in `info.json` have translations
- [ ] **Dependency graph** — validate `dependencies` in `info.json` exist and are satisfiable
- [ ] **Asset duplication** — find identical files across mod versions or within the same mod
- [ ] **Unused assets** — flag images/sounds not referenced by any Lua prototype
- [ ] **Info.json validation** — check required fields, semver, factorio_version compatibility
- [ ] **License check** — detect license file, flag missing or restrictive licenses
- [ ] **Changelog quality** — check that `changelog.txt` exists and has meaningful entries
- [ ] **Migration scripts** — validate `migrations/` against current version
- [ ] **Thumbnail check** — verify `thumbnail.png` exists and is reasonable size

## Infrastructure

- [ ] **Batch mode** — analyze all mods from a `mod-list.json` (single-player mod list)
- [ ] **GitHub Action** — CI that runs audit on PRs that touch mod files
- [ ] **Pre-commit hook** — run audit before committing mod changes
- [ ] **Caching** — cache downloaded mods by hash to avoid re-download
- [ ] **Parallel downloads** — fetch multiple mods concurrently in batch mode
- [ ] **Progress bar** — visual progress during download/extract/analyze

## Advanced

- [ ] **ClamAV integration** — call `clamscan` binary for real virus scanning
- [ ] **Behavioral analysis** — run Lua code in a sandboxed VM (e.g., `lua-sandbox`) to detect dangerous calls
- [ ] **Diff mode** — compare two versions of the same mod and report changes
- [ ] **Web UI** — simple dashboard to browse audit results
- [ ] **VirusTotal API** — submit file hash for additional scanning
- [ ] **SBOM generation** — produce a software bill of materials for each mod
- [ ] **Mod portal scraper** — gather download counts, ratings, last updated date
- [ ] **Auto-update checker** — compare local mod version against latest on portal
- [ ] **Plugin system** — allow third-party analyzers via a simple interface
- [ ] **Report history** — store historical scores to track quality over time

## Ideas to explore

- Check for **minified/obfuscated Lua** (high token density, short variable names)
- Detect **embedded credentials** (API keys, tokens in strings)
- Verify **checksum integrity** — compare zip hash against portal if available
- **i18n coverage** — which locales are missing translations
- **Prototype collision** — detect two mods defining the same prototype name
- **Tile/entity overlap** — flag mods that modify the same vanilla entities
