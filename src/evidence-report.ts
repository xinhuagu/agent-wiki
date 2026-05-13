/**
 * Evidence-first phase 4 — corpus-level evidence report.
 *
 * Aggregates the four telemetry sources earlier phases emit and renders
 * a single readable Markdown summary. This is what makes "is this wiki
 * evidence-first?" a question with a numerical answer.
 *
 * Sources:
 *   - Page frontmatter (Phase 2a): grounded / synthesis / unsupported /
 *     legacy-unsupported counts via `wiki.listAllPages` + gray-matter.
 *   - Per-write counter + unsupported log (Phase 2a): trend over the
 *     last 4 weeks via `readWriteCounter` / `readWriteLog`.
 *   - COBOL field-lineage artifact (Phase 3): `raw/parsed/cobol/field-lineage.json`
 *     carries `callBoundLineage.summary` and `db2Lineage.summary` with
 *     `diagnosticsByKind`.
 *   - Search trust (Phase 1 + Phase 4): per-search events from
 *     `evidence-search-log.jsonl`, written by `buildSearchEnvelope` via
 *     the `onEvent` callback. Yields total searches, abstain ratio,
 *     median top1 BM25, and a top1/top2 ratio histogram. The absolute
 *     BM25 floor still drives the abstain decision; a percentile cutoff
 *     informed by this log is a future option (see docs/evidence-envelope.md).
 *
 * See docs/evidence-envelope.md and issue #8.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import matter from "gray-matter";
import { isSystemPage, type Wiki } from "./wiki.js";
import { readWriteCounter } from "./evidence-write-log.js";
import { readSearchLog, type SearchEvent } from "./evidence-search-log.js";

export interface SourceCoverage {
  total: number;
  grounded: number;
  synthesis: number;
  unsupported: number;
  legacyUnsupported: number;
  other: number;
}

export interface LineageDiagnosticsSection {
  callSites?: number;
  pairs: number;
  sharedTables?: number;
  diagnosticsByKind: Record<string, number>;
  totalDiagnostics: number;
}

/**
 * Top-level field-lineage diagnostics — flag input models that produced no
 * usable data (e.g. listing-extracted copybooks). Distinct from `callBound` /
 * `db2` sections which describe cross-program join failures.
 */
export interface FieldLineageDiagnosticsSection {
  diagnosticsByKind: Record<string, number>;
  totalDiagnostics: number;
}

export interface TrendBucket {
  weekStart: string;
  unsupportedOrRejected: number;
  totalWrites: number;
}

export interface SearchTrust {
  totalSearches: number;
  abstainCount: number;
  abstainRatio: number | null; // null when totalSearches === 0
  medianTop1Score: number | null;
  ratioHistogram: { lt15: number; lt20: number; lt30: number; ge30: number };
}

export interface EvidenceReport {
  generatedAt: string;
  source: SourceCoverage;
  searchTrust: SearchTrust;
  lineage: {
    callBound?: LineageDiagnosticsSection;
    db2?: LineageDiagnosticsSection;
    fieldLineage?: FieldLineageDiagnosticsSection;
  };
  trend: TrendBucket[];
}

export function buildEvidenceReport(
  wiki: Wiki,
  now: Date = new Date(),
): EvidenceReport {
  return {
    generatedAt: now.toISOString(),
    source: aggregateSourceCoverage(wiki),
    searchTrust: aggregateSearchTrust(wiki, now),
    lineage: aggregateCobolLineage(wiki),
    trend: aggregateTrend(wiki, now),
  };
}

function aggregateSearchTrust(wiki: Wiki, now: Date): SearchTrust {
  const events = readSearchLog(wiki.config.workspace, now);
  const totalSearches = events.length;
  if (totalSearches === 0) {
    return {
      totalSearches: 0,
      abstainCount: 0,
      abstainRatio: null,
      medianTop1Score: null,
      ratioHistogram: { lt15: 0, lt20: 0, lt30: 0, ge30: 0 },
    };
  }
  const abstainCount = events.filter((e) => e.abstainReason !== null).length;
  const top1Scores = events
    .map((e) => e.top1Score)
    .filter((s): s is number => typeof s === "number")
    .sort((a, b) => a - b);
  const medianTop1Score = median(top1Scores);
  const ratioHistogram = bucketRatios(events);
  return {
    totalSearches,
    abstainCount,
    abstainRatio: abstainCount / totalSearches,
    medianTop1Score,
    ratioHistogram,
  };
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function bucketRatios(events: SearchEvent[]): SearchTrust["ratioHistogram"] {
  // Buckets chosen around the strong/weak boundary (2.0). Single-result
  // matches (top1Top2Ratio === null) are excluded from the histogram —
  // they have no comparator and shouldn't skew the distribution.
  //
  // Invariant: `top1Top2Ratio` is always a positive finite number when
  // non-null — buildSearchEnvelope sets it to `top1/top2` only when
  // `top2 > 0`, otherwise null. The lt15 bucket therefore captures `(0, 1.5)`,
  // not negative or zero ratios.
  const out = { lt15: 0, lt20: 0, lt30: 0, ge30: 0 };
  for (const e of events) {
    const r = e.top1Top2Ratio;
    if (r === null || !Number.isFinite(r)) continue;
    if (r < 1.5) out.lt15 += 1;
    else if (r < 2.0) out.lt20 += 1;
    else if (r < 3.0) out.lt30 += 1;
    else out.ge30 += 1;
  }
  return out;
}

function aggregateSourceCoverage(wiki: Wiki): SourceCoverage {
  let total = 0;
  let grounded = 0;
  let synthesis = 0;
  let unsupported = 0;
  let legacyUnsupported = 0;
  let other = 0;

  for (const pagePath of wiki.listAllPages()) {
    if (isSystemPage(pagePath)) continue;
    const fullPath = join(wiki.config.wikiDir, pagePath);
    let raw: string;
    try {
      raw = readFileSync(fullPath, "utf-8");
    } catch {
      continue; // unreadable — skip rather than crash the whole report
    }
    let fm: Record<string, unknown>;
    try {
      fm = matter(raw).data as Record<string, unknown>;
    } catch {
      // Malformed frontmatter; counts as "other" rather than blocking.
      other += 1;
      total += 1;
      continue;
    }

    total += 1;
    // Order matters: a page with both `sources: [...]` and `synthesis: true`
    // is a synthesis page that cites supports — count it as synthesis once.
    // Unsupported and legacyUnsupported are mutually exclusive by construction
    // (wiki.write strips one when stamping the other).
    const isSynthesis =
      fm.synthesis === true || fm.type === "synthesis";
    const sources = Array.isArray(fm.sources) ? fm.sources : [];
    if (isSynthesis) {
      synthesis += 1;
    } else if (sources.length > 0) {
      grounded += 1;
    } else if (fm.unsupported === true) {
      unsupported += 1;
    } else if (fm.legacyUnsupported === true) {
      legacyUnsupported += 1;
    } else {
      // A page with no sources, no synthesis flag, and no unsupported tag
      // — possible if classification was bypassed at write time. Surface as
      // "other" so the operator can investigate; not silently bucketed.
      other += 1;
    }
  }

  return { total, grounded, synthesis, unsupported, legacyUnsupported, other };
}

function aggregateCobolLineage(wiki: Wiki): EvidenceReport["lineage"] {
  const artifactPath = join(
    wiki.config.rawDir,
    "parsed",
    "cobol",
    "field-lineage.json",
  );
  if (!existsSync(artifactPath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(artifactPath, "utf-8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const lineage = parsed as Record<string, unknown>;

  const out: EvidenceReport["lineage"] = {};

  const callBound = lineage.callBoundLineage as
    | { summary?: { callSites?: number; pairs?: number; diagnosticsByKind?: Record<string, number> } }
    | null
    | undefined;
  if (callBound?.summary) {
    const diagnosticsByKind = callBound.summary.diagnosticsByKind ?? {};
    out.callBound = {
      callSites: callBound.summary.callSites ?? 0,
      pairs: callBound.summary.pairs ?? 0,
      diagnosticsByKind,
      totalDiagnostics: Object.values(diagnosticsByKind).reduce(
        (a, b) => a + b,
        0,
      ),
    };
  }

  const db2 = lineage.db2Lineage as
    | { summary?: { sharedTables?: number; pairs?: number; diagnosticsByKind?: Record<string, number> } }
    | null
    | undefined;
  if (db2?.summary) {
    const diagnosticsByKind = db2.summary.diagnosticsByKind ?? {};
    out.db2 = {
      sharedTables: db2.summary.sharedTables ?? 0,
      pairs: db2.summary.pairs ?? 0,
      diagnosticsByKind,
      totalDiagnostics: Object.values(diagnosticsByKind).reduce(
        (a, b) => a + b,
        0,
      ),
    };
  }

  // #30 — top-level field-lineage diagnostics (e.g. parsed-zero-data-items).
  // Pre-#30 artifacts won't carry summary.diagnosticsByKind, so absence here
  // is treated as "no diagnostics" rather than a parse failure.
  const summary = lineage.summary as
    | { diagnosticsByKind?: Record<string, number> }
    | null
    | undefined;
  if (summary?.diagnosticsByKind) {
    const diagnosticsByKind = summary.diagnosticsByKind;
    const totalDiagnostics = Object.values(diagnosticsByKind).reduce(
      (a, b) => a + b,
      0,
    );
    if (totalDiagnostics > 0) {
      out.fieldLineage = { diagnosticsByKind, totalDiagnostics };
    }
  }

  return out;
}

const WEEKS_OF_TREND = 4;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function aggregateTrend(wiki: Wiki, now: Date): TrendBucket[] {
  // Counter is the sole source. Pre-counter deployments will show 0/0 for
  // the weeks before the counter was introduced; this self-resolves within
  // 4 weeks of running the upgraded code. A per-week fallback to the
  // unsupported log was rejected: it produces "5 unsupported / 0 writes"
  // rows that read like a data error to the operator.
  const counter = readWriteCounter(wiki.config.workspace, now);
  const buckets: TrendBucket[] = [];
  for (let i = WEEKS_OF_TREND - 1; i >= 0; i--) {
    const end = now.getTime() - i * ONE_WEEK_MS;
    const start = end - ONE_WEEK_MS;
    const weekStart = new Date(start).toISOString().slice(0, 10);
    const inWeek = (ts: string) => {
      const t = new Date(ts).getTime();
      return Number.isFinite(t) && t >= start && t < end;
    };
    const weekEvents = counter.filter((e) => inWeek(e.timestamp));
    const unsupportedOrRejected = weekEvents.filter(
      (e) => e.kind === "unsupported" || e.kind === "rejected",
    ).length;
    buckets.push({
      weekStart,
      unsupportedOrRejected,
      totalWrites: weekEvents.length,
    });
  }
  return buckets;
}

const SPARK_BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (max === 0) return values.map(() => SPARK_BARS[0]).join("");
  return values
    .map((v) => {
      const idx = Math.min(
        SPARK_BARS.length - 1,
        Math.floor((v / max) * (SPARK_BARS.length - 1)),
      );
      return SPARK_BARS[idx];
    })
    .join("");
}

export function renderEvidenceReport(report: EvidenceReport): string {
  const lines: string[] = [];
  lines.push(`# Evidence Report`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");

  // ── Section 1: Source coverage ─────────────────────────────────────
  lines.push(`## Source coverage`);
  lines.push("");
  const s = report.source;
  if (s.total === 0) {
    lines.push(`No user-authored or compiler-generated pages yet.`);
  } else {
    const pct = (n: number) => `${((n / s.total) * 100).toFixed(1)}%`;
    lines.push(`- ${s.total} pages total`);
    lines.push(`- ${s.grounded} grounded (with \`sources: [...]\`) — ${pct(s.grounded)}`);
    lines.push(`- ${s.synthesis} synthesis (\`synthesis: true\`) — ${pct(s.synthesis)}`);
    lines.push(`- ${s.unsupported} unsupported (\`unsupported: true\`) — ${pct(s.unsupported)}`);
    lines.push(`- ${s.legacyUnsupported} legacy-unsupported — ${pct(s.legacyUnsupported)}`);
    if (s.other > 0) {
      lines.push(`- ${s.other} other (no classification — investigate) — ${pct(s.other)}`);
    }
  }
  lines.push("");

  // ── Section 2: Search trust ────────────────────────────────────────
  lines.push(`## Search trust`);
  lines.push("");
  const st = report.searchTrust;
  if (st.totalSearches === 0) {
    lines.push(
      `_No search activity in the last 30 days. The Search trust section `
        + `populates as \`wiki_search\` / \`wiki_search_read\` calls accumulate._`,
    );
  } else {
    const abstainPct =
      st.abstainRatio === null
        ? "—"
        : `${(st.abstainRatio * 100).toFixed(1)}%`;
    const median =
      st.medianTop1Score === null ? "—" : st.medianTop1Score.toFixed(2);
    lines.push(`- ${st.totalSearches} search(es) in the last 30 days`);
    lines.push(`- ${st.abstainCount} abstained — ${abstainPct}`);
    lines.push(`- Median top1 BM25 score: ${median}`);
    lines.push("");
    lines.push(`Top1/top2 ratio distribution (single-result matches excluded):`);
    lines.push("");
    lines.push(`| < 1.5 | 1.5–2.0 | 2.0–3.0 | ≥ 3.0 |`);
    lines.push(`|-------|---------|---------|-------|`);
    lines.push(
      `| ${st.ratioHistogram.lt15} | ${st.ratioHistogram.lt20} | ${st.ratioHistogram.lt30} | ${st.ratioHistogram.ge30} |`,
    );
  }
  lines.push("");

  // ── Section 3: Lineage diagnostic surfacing ────────────────────────
  lines.push(`## Lineage diagnostic surfacing`);
  lines.push("");
  if (!report.lineage.callBound && !report.lineage.db2 && !report.lineage.fieldLineage) {
    lines.push(
      `_No COBOL lineage artifacts found at \`raw/parsed/cobol/field-lineage.json\`. `
        + `Run \`wiki_admin --action rebuild\` after ingesting COBOL sources to populate this section._`,
    );
  } else {
    if (report.lineage.fieldLineage) {
      const fl = report.lineage.fieldLineage;
      lines.push(`### COBOL field-lineage inputs`);
      lines.push("");
      lines.push(`- ${fl.totalDiagnostics} diagnostic(s) surfaced`);
      for (const [kind, count] of Object.entries(fl.diagnosticsByKind)) {
        if (count > 0) lines.push(`  - \`${kind}\`: ${count}`);
      }
      lines.push("");
    }
    if (report.lineage.callBound) {
      const cb = report.lineage.callBound;
      lines.push(`### COBOL call-bound`);
      lines.push("");
      lines.push(`- ${cb.pairs} field pair(s) across ${cb.callSites} call site(s)`);
      lines.push(`- ${cb.totalDiagnostics} diagnostic(s) surfaced`);
      if (cb.totalDiagnostics > 0) {
        for (const [kind, count] of Object.entries(cb.diagnosticsByKind)) {
          if (count > 0) lines.push(`  - \`${kind}\`: ${count}`);
        }
      }
      lines.push("");
    }
    if (report.lineage.db2) {
      const d = report.lineage.db2;
      lines.push(`### COBOL DB2`);
      lines.push("");
      lines.push(`- ${d.pairs} writer→reader pair(s) across ${d.sharedTables} shared table(s)`);
      lines.push(`- ${d.totalDiagnostics} diagnostic(s) surfaced`);
      if (d.totalDiagnostics > 0) {
        for (const [kind, count] of Object.entries(d.diagnosticsByKind)) {
          if (count > 0) lines.push(`  - \`${kind}\`: ${count}`);
        }
      }
      lines.push("");
    }
  }

  // ── Section 4: Trend (last 4 weeks) ────────────────────────────────
  lines.push(`## Trend (last ${WEEKS_OF_TREND} weeks)`);
  lines.push("");
  const numerator = report.trend.map((b) => b.unsupportedOrRejected);
  const totals = report.trend.map((b) => b.totalWrites);
  const allZero = numerator.every((n) => n === 0) && totals.every((n) => n === 0);
  if (allZero) {
    lines.push(`_No write activity in the last ${WEEKS_OF_TREND} weeks._`);
  } else {
    const numeratorBars = sparkline(numerator);
    const totalsBars = sparkline(totals);
    lines.push(
      `- Unsupported-or-rejected per week: ${numeratorBars} `
        + `(${numerator.join(", ")})`,
    );
    lines.push(
      `- Total writes per week:            ${totalsBars} `
        + `(${totals.join(", ")})`,
    );
    lines.push("");
    lines.push(`| Week start | Total writes | Unsupported-or-rejected |`);
    lines.push(`|------------|--------------|-------------------------|`);
    for (const b of report.trend) {
      lines.push(`| ${b.weekStart} | ${b.totalWrites} | ${b.unsupportedOrRejected} |`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate the report and optionally persist it. Returns the rendered
 * markdown so the MCP caller can also surface it inline.
 */
export function runEvidenceReport(
  wiki: Wiki,
  opts: { write?: boolean; now?: Date } = {},
): { report: EvidenceReport; markdown: string; writtenTo?: string } {
  const report = buildEvidenceReport(wiki, opts.now);
  const markdown = renderEvidenceReport(report);
  let writtenTo: string | undefined;
  if (opts.write) {
    // Route through wiki.write() so frontmatter normalization (created /
    // updated timestamps) and the page cache are kept consistent.
    // `evidence-report.md` is registered as a system page in wiki.ts, so
    // wiki.write skips evidence classification automatically — the counter
    // doesn't tick on report regeneration.
    const withFrontmatter =
      `---\ntitle: "Evidence Report"\ntype: synthesis\nsynthesis: true\n---\n\n`
      + markdown;
    wiki.write("evidence-report.md", withFrontmatter, "wiki_admin");
    writtenTo = relative(
      wiki.config.workspace,
      join(wiki.config.wikiDir, "evidence-report.md"),
    );
  }
  return { report, markdown, writtenTo };
}
