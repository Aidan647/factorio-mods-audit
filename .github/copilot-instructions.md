# GitHub Copilot Instructions

**Purpose:** Technical workflow rules for development.  
**Tone:** Concise, action-oriented. Be brief.

## Core Rules

- Ask clarifying questions; correct when wrong
- Don't guess large scopes; supply exact file paths
- Follow lints; prefer small, reversible commits
- Keep answers minimal unless detail requested
- Explicit constraints: Bun, TypeScript, ESM
- Avoid try-catch; prefer `await promise.catch(() => fallback)`

## Types & Type Safety

Use TypeScript types/interfaces for shared data in `src/types`. Update dependent modules and tests when changing types.

**Type Safety:**
- Avoid `as any` casts; use type guards instead
- For dynamic key access: `if (key in obj) { obj[key as keyof typeof obj] }`
- Import types from `src/types` rather than inline definitions
- Use `keyof` and mapped types for config access patterns

## Tests

- Place in `./test/` mirroring source structure: `src/module/example.ts` → `test/module/example.test.ts`
- Use Bun test runner (`bun test`)
- Ask user to validate after creating/modifying
- Run only when requested or to validate changes

## Request Templates

- **Bug:** "Fix bug in [file] where [behavior]. Reproduce: [steps]. Expected: [result]. Constraints: [lint/API]."
- **Feature:** "Add [feature] to [file]. Design: [one-paragraph]. Tests: [what to add]."
- **Refactor:** "Refactor [file] to improve [goal]. Keep behavior identical; include tests; list files changed."
- **Tests:** "Add unit tests for [module]. Targets: [edge cases]. Runner: [how to run]."

## Tools

Preferred order: (1) native Bun APIs, (2) lightweight ESM libs (e.g., `undici`, `zod`), (3) native bindings only when necessary (e.g., `sharp`).

**Two tool directories:**
- `./tools/` - CLI scripts/build tools run via `bun run <tool>` (e.g., build scripts, migrations, utilities)
- `./src/tools/` - Runtime utilities used by running instance via `bun start` (e.g., helpers, parsers, formatters)

Reuse existing tools when available. Update relevant README when adding tools. Include `package.json` diff and install command for new deps.

Use `bun typecheck` and `bun format` to check types and format before running tests with `bun test`.

## Workflow & Documentation

**Commits/PRs:** Format: `type: summary`. PRs include summary + test results + verification steps.

**Folder READMEs:** Create/update README.md in folders you modify. Brief: purpose + how it works (short paragraph + bullets). Note changes, rationale, migration steps.

**Process:** Propose minimal patches before applying; ask for approval on multi-file changes. Provide diffs/patches, confirm risky changes.

## Configuration & Development

**Config Format:**
- Root config uses JSON5 format (`config.json5`) supporting comments and trailing commas
- Per-section configs use standard JSON where appropriate
- Copy `example.config.json5` to `config.json5` for initial setup

**Development Mode:**
- `src/index.ts` may contain commented test/example code during active development
- Debug logging (e.g., memory stats) acceptable during dev; gate behind env flag for production

## Error Handling

- **Async operations**: Use `.catch(() => fallback)` pattern, NOT try-catch
  - Example: `await file.read().catch(() => null)`
  - Chain with `.then()` for multi-step: `await op().then(next).catch(fallback)`
- **Sync operations**: try-catch is acceptable when no async alternative exists
  - Example: Synchronous parsers that throw for invalid input
- **State changes in catch**: Keep try-catch if error handler must modify object state
