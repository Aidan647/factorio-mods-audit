import { bytesToHuman } from "#/helpers/humanify"
import type { AuditReport, Finding } from "."

// ── helpers ──────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function severityLabel(s?: string): string {
	switch (s) {
		case "high":
			return "HIGH"
		case "medium":
			return "MED"
		case "low":
			return "LOW"
		default:
			return "INFO"
	}
}

function severityBadge(s?: string): string {
	switch (s) {
		case "high":
			return `<span class="sev-high">[HIGH]</span>`
		case "medium":
			return `<span class="sev-med">[MED]</span>`
		case "low":
			return `<span class="sev-low">[LOW]</span>`
		default:
			return `<span class="sev-info">[INFO]</span>`
	}
}

function fmtTimestamp(ts: number): string {
	const d = new Date(ts)
	return d.toISOString().slice(0, 19).replace("T", " ")
}

function sortFindings(fs: Finding[]): Finding[] {
	const order: Record<string, number> = { high: 0, medium: 1, low: 2 }
	return [...fs].sort((a, b) => (order[a.severity ?? ""] ?? 3) - (order[b.severity ?? ""] ?? 3))
}

// ── TXT formatter ────────────────────────────────────────────────────────────

export function formatTxt(report: AuditReport): string {
	const lines: string[] = []

	// header
	lines.push("=".repeat(60))
	lines.push("  MOD AUDIT REPORT")
	lines.push("=".repeat(60))
	lines.push(`  Mod:          ${report.modName} v${report.version} (https://mods.factorio.com/mod/${report.modName})`)
	lines.push(`  Score:        ${report.score.toFixed(1)} / 100`)
	lines.push(`  Timestamp:    ${fmtTimestamp(report.timestamp)}`)
	lines.push(`  SHA1:         ${report.sha1}`)
	if (report.modSize) lines.push(`  Mod size:     ${bytesToHuman(report.modSize)}`)
	if (report.potentialSavings) lines.push(`  Savings:      ${bytesToHuman(report.potentialSavings)}`)
	if (report.percentageSavings) lines.push(`  Reduction:    ${report.percentageSavings}%`)
	lines.push("")

	// preflight findings
	if (report.preflightFindings && report.preflightFindings.length > 0) {
		lines.push("-- Pre-flight Findings -------------------------------------------------")
		for (const f of sortFindings(report.preflightFindings)) {
			lines.push(`  [${severityLabel(f.severity)}] ${f.description}`)
			if (f.paths?.length) lines.push(`         ${f.paths.join(", ")}`)
		}
		lines.push("")
	}

	// scanner results
	for (const s of report.scanners) {
		lines.push(`-- ${s.id} ----------------------------------------------------------------`)
		lines.push(`  Score:   ${s.score.toFixed(1)} / 100`)
		lines.push(`  Weight:  ${s.weight}`)
		lines.push(`  Savings: ${bytesToHuman(s.savings)}`)
		if (s.findings.length > 0) {
			lines.push(`  Findings:`)
			for (const f of sortFindings(s.findings)) {
				lines.push(`    [${severityLabel(f.severity)}] ${f.description}`)
				if (f.potentialSavings) lines.push(`           Potential saving: ${bytesToHuman(f.potentialSavings)}`)
				if (f.paths?.length) lines.push(`           ${f.paths.join(", ")}`)
			}
		} else {
			lines.push(`  Findings: none`)
		}
		lines.push("")
	}

	// errors
	if (report.errors && report.errors.length > 0) {
		lines.push("-- Errors ----------------------------------------------------------------")
		for (const e of report.errors) lines.push(`  ${e}`)
		lines.push("")
	}

	lines.push("=".repeat(60))
	return lines.join("\n")
}

// ── MD formatter ─────────────────────────────────────────────────────────────

export function formatMd(report: AuditReport): string {
	const lines: string[] = []

	lines.push(
		`# Mod Audit Report: [${report.modName} v${report.version}](https://mods.factorio.com/mod/${report.modName})`,
	)
	lines.push("")
	lines.push("| Field | Value |")
	lines.push("|---|---|")
	lines.push(`| **Score** | ${report.score.toFixed(1)} / 100 |`)
	lines.push(`| **Timestamp** | ${fmtTimestamp(report.timestamp)} |`)
	lines.push(`| **SHA1** | \`${report.sha1}\` |`)
	if (report.modSize) lines.push(`| **Mod size** | ${bytesToHuman(report.modSize)} |`)
	if (report.potentialSavings) lines.push(`| **Potential savings** | ${bytesToHuman(report.potentialSavings)} |`)
	if (report.percentageSavings) lines.push(`| **Size reduction** | ${report.percentageSavings}% |`)
	lines.push("")

	// pre-flight
	if (report.preflightFindings && report.preflightFindings.length > 0) {
		lines.push("## Pre-flight Findings")
		lines.push("")
		lines.push("| Severity | Description | Paths |")
		lines.push("|---|---|---|")
		for (const f of sortFindings(report.preflightFindings)) {
			lines.push(`| ${severityLabel(f.severity)} | ${f.description} | ${f.paths?.join("<br>") ?? ""} |`)
		}
		lines.push("")
	}

	// scanners
	lines.push("## Scanner Results")
	lines.push("")
	for (const s of report.scanners) {
		lines.push(`### ${s.id}`)
		lines.push("")
		lines.push("| Metric | Value |")
		lines.push("|---|---|")
		lines.push(`| **Score** | ${s.score.toFixed(1)} / 100 |`)
		lines.push(`| **Weight** | ${s.weight} |`)
		lines.push(`| **Savings** | ${bytesToHuman(s.savings)} |`)
		lines.push("")

		if (s.findings.length > 0) {
			lines.push("#### Findings")
			lines.push("")
			lines.push("| # | Severity | Description | Savings | Paths |")
			lines.push("|---|---|---|---|---|")
			for (let i = 0; i < sortFindings(s.findings).length; i++) {
				const f = sortFindings(s.findings)[i]
				if (!f) continue
				lines.push(
					`| ${i + 1} | ${severityLabel(f.severity)} | ${f.description} | ${f.potentialSavings ? bytesToHuman(f.potentialSavings) : ""} | ${f.paths?.join("<br>") ?? ""} |`,
				)
			}
			lines.push("")
		} else {
			lines.push("_No findings._")
			lines.push("")
		}
	}

	// errors
	if (report.errors && report.errors.length > 0) {
		lines.push("## Errors")
		lines.push("")
		for (const e of report.errors) lines.push(`- ${e}`)
		lines.push("")
	}

	return lines.join("\n")
}

// ── HTML formatter ───────────────────────────────────────────────────────────

export function formatHtml(report: AuditReport): string {
	const MAX_FINDINGS = 6
	const MAX_PATHS = 3

	function renderPaths(paths: string[] | undefined): string {
		if (!paths || paths.length === 0) return ""
		const items = paths.map((p) => `<code>${escHtml(p)}</code>`)
		if (paths.length <= MAX_PATHS + 2) return items.join("<br>")
		const visibleItems = items.slice(0, MAX_PATHS)
		const hiddenItems = items.slice(MAX_PATHS)
		return `
                  <span class="path-group">
                    ${visibleItems.join("<br>")}<br>
                    <span class="paths-extra" style="display:none">${hiddenItems.join("<br>")}</span>
                    <button class="toggle-paths-btn" onclick="this.previousElementSibling.style.display='inline';this.style.display='none'">+${hiddenItems.length} more</button>
                  </span>`
	}

	const scannerRows = report.scanners
		.map((s) => {
			const sorted = sortFindings(s.findings)
			const truncated = sorted.length > MAX_FINDINGS
			const visible = truncated ? sorted.slice(0, MAX_FINDINGS) : sorted
			const hidden = truncated ? sorted.slice(MAX_FINDINGS) : []

			const findingsRows = visible
				.map((f) => {
					const pathsHtml = renderPaths(f.paths)
					const saving = f.potentialSavings
						? `<span class="saving">${bytesToHuman(f.potentialSavings)}</span>`
						: ""
					return `
                <tr class="finding finding-${f.severity ?? "info"}">
                  <td>${severityBadge(f.severity)}</td>
                  <td>${escHtml(f.description)}</td>
                  <td>${saving}</td>
                  <td>${pathsHtml}</td>
                </tr>`
				})
				.join("\n")

			const hiddenRows = hidden
				.map((f) => {
					const pathsHtml = renderPaths(f.paths)
					const saving = f.potentialSavings
						? `<span class="saving">${bytesToHuman(f.potentialSavings)}</span>`
						: ""
					return `
                <tr class="finding finding-${f.severity ?? "info"} hidden-finding" style="display:none">
                  <td>${severityBadge(f.severity)}</td>
                  <td>${escHtml(f.description)}</td>
                  <td>${saving}</td>
                  <td>${pathsHtml}</td>
                </tr>`
				})
				.join("\n")

			const scoreColor =
				report.score >= 80
					? "#22c55e"
					: report.score >= 50
						? "#eab308"
						: report.score >= 25
							? "#f16338"
							: "#f82424"
			const bar = `<div class="score-bar"><div class="score-fill" style="width:${s.score}%;background:${scoreColor}"></div></div>`

			return `
          <div class="scanner">
            <div class="scanner-header">
              <h3><span class="scanner-id">${escHtml(s.id)}</span></h3>
              <div class="scanner-score">
                <span class="score-num" style="color:${scoreColor}">${s.score.toFixed(1)}</span>
                <span class="score-label">/ 100</span>
                ${bar}
              </div>
            </div>
            <div class="scanner-meta">
              <span class="meta-item"><strong>Weight:</strong> ${s.weight}</span>
              <span class="meta-item"><strong>Savings:</strong> ${bytesToHuman(s.savings)}</span>
            </div>
            ${
				s.findings.length > 0
					? `
            <table class="findings-table">
              <thead>
                <tr><th>Severity</th><th>Description</th><th>Savings</th><th>Paths</th></tr>
              </thead>
              <tbody>
                ${findingsRows}
                ${hiddenRows}
              </tbody>
            </table>
            ${truncated ? `<button class="toggle-findings-btn" onclick="const t=this.previousElementSibling.querySelectorAll('.hidden-finding');t.forEach(r=>r.style.display='');this.style.display='none'">Show all ${sorted.length} findings</button>` : ""}
            `
					: `<p class="no-findings">No findings</p>`
			}
          </div>`
		})
		.join("\n")

	const preflightSection =
		report.preflightFindings && report.preflightFindings.length > 0
			? `
        <div class="section">
          <h2>Pre-flight Findings</h2>
          <table class="findings-table">
            <thead>
              <tr><th>Severity</th><th>Description</th><th>Paths</th></tr>
            </thead>
            <tbody>
              ${sortFindings(report.preflightFindings)
					.map(
						(f) => `
                <tr class="finding finding-${f.severity ?? "info"}">
                  <td>${severityBadge(f.severity)}</td>
                  <td>${escHtml(f.description)}</td>
                  <td>${renderPaths(f.paths)}</td>
                </tr>`,
					)
					.join("\n")}
            </tbody>
          </table>
        </div>`
			: ""

	const errorsSection =
		report.errors && report.errors.length > 0
			? `
        <div class="section">
          <h2>Errors</h2>
          <ul class="errors-list">
            ${report.errors.map((e) => `<li>${escHtml(e)}</li>`).join("\n")}
          </ul>
        </div>`
			: ""

	const overallColor =
		report.score >= 80 ? "#22c55e" : report.score >= 50 ? "#eab308" : report.score >= 25 ? "#f16338" : "#f80606"
	const savingsHtml = report.potentialSavings
		? `
          <div class="stat-card">
            <span class="stat-label">Potential Savings</span>
            <span class="stat-value">${bytesToHuman(report.potentialSavings)}</span>
            ${report.percentageSavings ? `<span class="stat-sub">${report.percentageSavings}% reduction</span>` : ""}
          </div>`
		: ""

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Audit Report: ${escHtml(report.modName)} v${escHtml(report.version)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #0f172a; color: #e2e8f0; padding: 2rem; line-height: 1.6;
  }
  .container { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.2rem; margin: 1.5rem 0 1rem; color: #94a3b8; border-bottom: 1px solid #1e293b; padding-bottom: 0.5rem; }
  h3 { font-size: 1rem; }
  .subtitle { color: #64748b; font-size: 0.85rem; margin-bottom: 0.5rem; }

  /* header */
  .report-header { margin-bottom: 2rem; }
  .report-meta { display: flex; gap: 1rem; flex-wrap: wrap; margin-top: 0.75rem; }
  .stat-card {
    background: #1e293b; border-radius: 8px; padding: 0.75rem 1rem; min-width: 140px;
    display: flex; flex-direction: column;
  }
  .stat-label { font-size: 0.75rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-value { font-size: 1.3rem; font-weight: 700; }
  .stat-value.score-val { font-size: 2rem; }
  .stat-sub { font-size: 0.8rem; color: #94a3b8; }

  /* overall score bar */
  .overall-bar { height: 8px; background: #1e293b; border-radius: 4px; margin-top: 0.75rem; overflow: hidden; }
  .overall-fill { height: 100%; border-radius: 4px; transition: width 0.5s ease; }

  /* scanner sections */
  .section { margin-bottom: 2rem; }
  .scanner {
    background: #1e293b; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem;
  }
  .scanner-header { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 0.5rem; }
  .scanner-id { font-family: "SF Mono", "Fira Code", monospace; color: #38bdf8; }
  .scanner-score { text-align: right; }
  .score-num { font-size: 1.4rem; font-weight: 800; }
  .score-label { font-size: 0.8rem; color: #64748b; }
  .score-bar { width: 120px; height: 6px; background: #334155; border-radius: 3px; margin-top: 4px; overflow: hidden; }
  .score-fill { height: 100%; border-radius: 3px; }
  .scanner-meta { display: flex; gap: 1.5rem; margin: 0.5rem 0 0.75rem; font-size: 0.85rem; color: #94a3b8; }

  /* tables */
  .findings-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  .findings-table th { text-align: left; color: #64748b; font-weight: 600; padding: 0.4rem 0.5rem; border-bottom: 1px solid #334155; }
  .findings-table td { padding: 0.5rem; border-bottom: 1px solid #1e293b; vertical-align: top; }
  .finding-high { background: rgba(240, 3, 3, 0.07); }
  .finding-medium { background: rgba(234,179,8,0.06); }
  .finding-low { background: rgba(34,197,94,0.04); }
  code {
    font-family: "SF Mono", "Fira Code", monospace; font-size: 0.8rem;
    background: #0f172a; padding: 0.1em 0.3em; border-radius: 3px;
    word-break: break-all;
  }
  .saving { color: #22c55e; font-weight: 600; white-space: nowrap; }

  /* severity badges */
  .sev-high { color: #ef4444; font-weight: 600; }
  .sev-med { color: #eab308; font-weight: 600; }
  .sev-low { color: #22c55e; }
  .sev-info { color: #64748b; }

  .no-findings { color: #22c55e; font-size: 0.85rem; }
  .errors-list { list-style: disc; padding-left: 1.25rem; color: #ef4444; }

  /* toggle buttons */
  .toggle-findings-btn, .toggle-paths-btn {
    background: #334155; color: #94a3b8; border: 1px solid #475569;
    border-radius: 4px; padding: 0.25rem 0.6rem; font-size: 0.75rem;
    cursor: pointer; margin-top: 0.5rem;
  }
  .toggle-findings-btn:hover, .toggle-paths-btn:hover { background: #475569; color: #e2e8f0; }
  .toggle-paths-btn { margin-top: 0.25rem; }

  @media (prefers-color-scheme: light) {
    body { background: #f8fafc; color: #1e293b; }
    .scanner, .stat-card { background: #ffffff; border: 1px solid #e2e8f0; }
    .score-bar { background: #e2e8f0; }
    .findings-table td { border-bottom-color: #f1f5f9; }
    .findings-table th { border-bottom-color: #e2e8f0; }
    h2 { border-bottom-color: #e2e8f0; color: #64748b; }
    code { background: #f1f5f9; }
    .subtitle { color: #94a3b8; }
    .finding-high { background: rgba(239,68,68,0.04); }
    .finding-medium { background: rgba(234,179,8,0.04); }
    .finding-low { background: rgba(34,197,94,0.03); }
    .overall-bar { background: #e2e8f0; }
    .toggle-findings-btn, .toggle-paths-btn { background: #e2e8f0; color: #64748b; border-color: #cbd5e1; }
    .toggle-findings-btn:hover, .toggle-paths-btn:hover { background: #cbd5e1; color: #334155; }
  }
</style>
</head>
<body>
<div class="container">
  <div class="report-header">
    <h1><a href="https://mods.factorio.com/mod/${escHtml(report.modName)}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:none">${escHtml(report.modNameReadable)}</a> <span style="color:#64748b">v${escHtml(report.version)}</span></h1>
    <div class="subtitle"><code>${escHtml(report.modName)}</code><br>SHA1: <code>${report.sha1}</code> &middot; ${fmtTimestamp(report.timestamp)}</div>
    <div class="report-meta">
      <div class="stat-card">
        <span class="stat-label">Overall Score</span>
        <span class="stat-value score-val" style="color:${overallColor}">${report.score.toFixed(1)}</span>
        <span class="stat-sub">/ 100</span>
      </div>
      ${
			report.modSize
				? `
      <div class="stat-card">
        <span class="stat-label">Mod Size</span>
        <span class="stat-value">${bytesToHuman(report.modSize)}</span>
      </div>`
				: ""
		}
      ${savingsHtml}
    </div>
    <div class="overall-bar"><div class="overall-fill" style="width:${report.score}%;background:${overallColor}"></div></div>
  </div>

  ${preflightSection}

  <div class="section">
    <h2>Scanner Results</h2>
    ${scannerRows}
  </div>

  ${errorsSection}
</div>
</body>
</html>`
}
