# Factorio Mods Audit

Audit Factorio mods for code quality, clutter, malware, and packaging issues. Downloads mods from the [Factorio Mod Portal](https://mods.factorio.com), runs a battery of checks, and produces a scored report.

Built with **Bun + TypeScript** (not Node.js compatible).

### `bun serve [options]`

WebSocket server for real-time scanning.

| Option   | Default   | Description  |
| -------- | --------- | ------------ |
| `--port` | `8080`    | Server port  |
| `--host` | `0.0.0.0` | Bind address |

## Scanners

| Scanner        | Weight | What It Checks                                               |
| -------------- | ------ | ------------------------------------------------------------ |
| **Clutter**    | 95     | Dev files, backups, VCS, OS metadata, IDE artifacts, secrets |
| **Duplicates** | 90     | Identical files wasting space (by content hash)              |
| **Images**     | 75     | PNG dimensions, mipmaps, optimization                        |
| **Luacheck**   | 65     | Lua static analysis (via pre-built binary)                   |
| **Metadata**   | 50     | `info.json` validity (name, version, dependencies, etc.)     |
| **Locale**     | 40     | Locale folder structure & `.cfg` file validity               |
| **Changelog**  | 30     | `changelog.txt` format compliance                            |

## Configuration

### Environment Variables

| Variable             | Default            | Required |
| -------------------- | ------------------ | -------- |
| `FACTORIO_USERNAME`  | —                  | Yes      |
| `FACTORIO_TOKEN`     | —                  | Yes      |
| `DATA_DIR`           | `./data`           | —        |
| `DISABLE_CLAMAV`     | `false`            | —        |
| `DISABLE_DISK_CACHE` | `false`            | —        |
| `CACHE_EXPIRY_MS`    | `2592000000` (30d) | —        |
| `SERVER_PORT`        | `8080`             | —        |
| `SERVER_HOST`        | `0.0.0.0`          | —        |

### Rules Files (JSON5, editable)

| File                        | Purpose                                  |
| --------------------------- | ---------------------------------------- |
| `data/clutter-rules.json5`  | File patterns to flag as clutter         |
| `data/image-rules.json5`    | Dimension & mipmap limits per image type |
| `data/luacheck-codes.json5` | Luacheck warning code descriptions       |

## Docker

```bash
cp docker-compose.yml.example docker-compose.yml
# Set FACTORIO_USERNAME and FACTORIO_TOKEN in docker-compose.yml
docker compose up -d
```

- Built on `oven/bun:slim` (Debian glibc — required for luacheck)
- ClamAV **disabled by default** in Docker
- Exposes port `3000`, mounts `./data:/app/data`
- Default command: WebSocket server

## Scoring

Each scanner produces a **0–100 score** (higher = better). The final score aggregates them by weight:

Scanners with higher weight have more impact on the final score. A critical failure in a high-weight scanner (e.g., clutter with weight 95 scoring 0) can severely drag the overall result.

## License

GPL-3.0
