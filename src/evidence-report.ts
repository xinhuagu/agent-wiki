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

/**
 * The number of weekly buckets the gates evaluate. Decoupled from the
 * `WEEKS_OF_TREND` constant that drives the cosmetic "Trend (last N
 * weeks)" sparkline so the gate's calibration doesn't silently change
 * if the display window is widened. The min-writes threshold below is
 * calibrated to exactly this many weeks; any change here should be
 * paired with a re-calibration of `PHASE2B_MIN_TOTAL_WRITES`.
 *
 * Invariant (enforced by `pickGateBuckets`): must be ≤ WEEKS_OF_TREND,
 * otherwise the gate's `slice(-N)` silently returns fewer buckets than
 * intended and the threshold would become incorrectly easier to pass.
 */
const PHASE2B_GATE_WEEKS = 4;
const PHASE2B_MIN_TOTAL_WRITES = 50;
const PHASE2B_MAX_WEEKLY_RATIO = 0.05;
const PHASE2B_MAX_SEARCH_ABSTAIN_RATIO = 0.30;
const PHASE2B_MIN_SEARCHES_FOR_GATE = 10;

/**
 * Canonical GitHub URL of the flip-criteria section, surfaced in the
 * rendered report's "ready" tip. Lifted to module scope so a repo
 * rename or fork only requires updating one literal. The test at
 * `evidence-report.test.ts` pins this constant indirectly via the
 * rendered output.
 *
 * Why absolute (not `../docs/...`): when `wiki/evidence-report.md`
 * is rendered under a user-supplied wiki/ dir, the wiki dir's
 * position relative to docs/ in `node_modules/@agent-wiki/mcp/` is
 * not stable — there is no guaranteed sibling path the operator
 * could click. (The npm package does ship `docs/` per package.json
 * `files`, but at an unrelated location.)
 */
const FLIP_CRITERIA_URL =
  "https://github.com/xinhuagu/agent-wiki/blob/main/docs/evidence-envelope.md#phase-2b-flip-criteria";

/**
 * Phase 2b readiness — operationalises the "once the would-reject ratio
 * settles" decision point in docs/evidence-envelope.md by checking the
 * already-aggregated telemetry against fixed numeric thresholds.
 *
 * Thresholds are intentionally conservative: Phase 2b makes wiki_write
 * hard-fail on unsupported pages, so a false-positive ready signal would
 * block legitimate writes. See docs/evidence-envelope.md "Phase 2b flip
 * criteria" for the rationale.
 */
export interface Phase2bReadiness {
  status: "ready" | "not-ready" | "insufficient-data";
  /** Already-enabled state from `wiki.config.evidence.rejectUnsupportedWrites`. */
  currentlyEnabled: boolean;
  /**
   * Per-gate verdicts. `totalWrites` and `weeklyRatio` always evaluate;
   * `searchAbstain` may report `applicable: false` when the 30-day search
   * volume is too low for the gate to be meaningful.
   */
  gates: {
    totalWrites: {
      value: number;
      threshold: number;
      passing: boolean;
    };
    weeklyRatio: {
      threshold: number;
      perWeek: Array<{
        weekStart: string;
        totalWrites: number;
        unsupportedOrRejected: number;
        ratio: number | null;       // null when totalWrites === 0
        passing: boolean;            // true when ratio is null (no signal) or < threshold
      }>;
      passing: boolean;             // every week with data passes
    };
    searchAbstain:
      | { applicable: true; value: number; threshold: number; passing: boolean }
      | { applicable: false; reason: string };
  };
  /** Plain-English summary of what is blocking readiness, if anything. */
  reasons: string[];
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
  phase2bReadiness: Phase2bReadiness;
}

export function buildEvidenceReport(
  wiki: Wiki,
  now: Date = new Date(),
): EvidenceReport {
  const searchTrust = aggregateSearchTrust(wiki, now);
  const trend = aggregateTrend(wiki, now);
  return {
    generatedAt: now.toISOString(),
    source: aggregateSourceCoverage(wiki),
    searchTrust,
    lineage: aggregateCobolLineage(wiki),
    trend,
    phase2bReadiness: assessPhase2bReadiness(wiki, trend, searchTrust),
  };
}

function assessPhase2bReadiness(
  wiki: Wiki,
  trend: TrendBucket[],
  searchTrust: SearchTrust,
): Phase2bReadiness {
  const currentlyEnabled = wiki.config.evidence.rejectUnsupportedWrites;
  const reasons: string[] = [];

  // Inline guard so a future bump of PHASE2B_GATE_WEEKS past WEEKS_OF_TREND
  // fails loud instead of silently making the gate easier to pass.
  if (trend.length < PHASE2B_GATE_WEEKS) {
    throw new Error(
      `Trend window (${trend.length}) shorter than PHASE2B_GATE_WEEKS (${PHASE2B_GATE_WEEKS}); widen WEEKS_OF_TREND.`,
    );
  }
  const gateBuckets = trend.slice(-PHASE2B_GATE_WEEKS);

  const totalWritesValue = gateBuckets.reduce((acc, b) => acc + b.totalWrites, 0);
  const totalWritesGate = {
    value: totalWritesValue,
    threshold: PHASE2B_MIN_TOTAL_WRITES,
    passing: totalWritesValue >= PHASE2B_MIN_TOTAL_WRITES,
  };

  const perWeek = gateBuckets.map((b) => {
    const ratio = b.totalWrites === 0 ? null : b.unsupportedOrRejected / b.totalWrites;
    // A week with no writes carries no signal — it neither confirms nor refutes
    // readiness, so it passes by default. The totalWrites gate catches the
    // case where all four weeks are empty.
    const passing = ratio === null || ratio < PHASE2B_MAX_WEEKLY_RATIO;
    return {
      weekStart: b.weekStart,
      totalWrites: b.totalWrites,
      unsupportedOrRejected: b.unsupportedOrRejected,
      ratio,
      passing,
    };
  });
  const weeklyRatioGate = {
    threshold: PHASE2B_MAX_WEEKLY_RATIO,
    perWeek,
    passing: perWeek.every((w) => w.passing),
  };

  const searchAbstainGate: Phase2bReadiness["gates"]["searchAbstain"] =
    searchTrust.totalSearches >= PHASE2B_MIN_SEARCHES_FOR_GATE &&
    searchTrust.abstainRatio !== null
      ? {
          applicable: true,
          value: searchTrust.abstainRatio,
          threshold: PHASE2B_MAX_SEARCH_ABSTAIN_RATIO,
          passing: searchTrust.abstainRatio <= PHASE2B_MAX_SEARCH_ABSTAIN_RATIO,
        }
      : {
          applicable: false,
          reason: `fewer than ${PHASE2B_MIN_SEARCHES_FOR_GATE} searches in the last 30 days — not enough signal to gate on`,
        };

  // Collect reasons for every failing gate, regardless of status. This keeps
  // the operator-visible "why" complete: if total writes are too thin AND a
  // week is over the ratio, both show up rather than only the first.
  if (!totalWritesGate.passing) {
    reasons.push(
      `Total writes over ${PHASE2B_GATE_WEEKS} weeks (${totalWritesValue}) below threshold (${PHASE2B_MIN_TOTAL_WRITES}). ` +
        `Wait for more activity before flipping — the ratio is statistically thin.`,
    );
  }
  // Invariant: `passing = ratio === null || ratio < threshold`, so `!passing`
  // mathematically implies `ratio !== null`. The bang below documents the
  // invariant at the use site; a discriminated union on passing would be
  // more elaborate than this small block warrants.
  const failingWeeks = perWeek.filter((w) => !w.passing);
  if (failingWeeks.length > 0) {
    const list = failingWeeks
      .map((w) => `${w.weekStart} (${(w.ratio! * 100).toFixed(1)}%)`)
      .join(", ");
    reasons.push(
      `${failingWeeks.length} week(s) above ${(PHASE2B_MAX_WEEKLY_RATIO * 100).toFixed(0)}% wouldRejectRatio: ${list}.`,
    );
  }
  if (searchAbstainGate.applicable && !searchAbstainGate.passing) {
    reasons.push(
      `Search abstain ratio (${(searchAbstainGate.value * 100).toFixed(1)}%) above ` +
        `${(PHASE2B_MAX_SEARCH_ABSTAIN_RATIO * 100).toFixed(0)}% — many queries are returning weak matches; ` +
        `Phase 2b would also tighten the supply side, compounding the problem.`,
    );
  }

  // Status: insufficient-data takes precedence (we can't make a real call yet
  // — a single bad week against 5 writes is noise, not signal). Otherwise,
  // every applicable gate must pass.
  let status: Phase2bReadiness["status"];
  if (!totalWritesGate.passing) {
    status = "insufficient-data";
  } else {
    const allGatesPass =
      weeklyRatioGate.passing &&
      (!searchAbstainGate.applicable || searchAbstainGate.passing);
    status = allGatesPass ? "ready" : "not-ready";
  }

  return {
    status,
    currentlyEnabled,
    gates: { totalWrites: totalWritesGate, weeklyRatio: weeklyRatioGate, searchAbstain: searchAbstainGate },
    reasons,
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

  // ── Section 5: Phase 2b readiness ──────────────────────────────────
  const r = report.phase2bReadiness;
  lines.push(`## Phase 2b readiness`);
  lines.push("");
  const statusLabel =
    r.status === "ready" ? "READY — gates pass; safe to consider flipping"
    : r.status === "not-ready" ? "NOT READY — see reasons below"
    : "INSUFFICIENT DATA — too few writes to judge yet";
  lines.push(`- Status: **${statusLabel}**`);
  // `currentlyEnabled` resolves from env var OR YAML config; don't attribute
  // to one specific knob since the operator may have flipped either.
  lines.push(`- Currently enabled: ${r.currentlyEnabled ? "yes" : "no"}`);
  lines.push("");

  lines.push(`### Gates`);
  lines.push("");
  const checkmark = (p: boolean) => (p ? "✓" : "✗");

  const tw = r.gates.totalWrites;
  lines.push(
    `- **Total writes (${PHASE2B_GATE_WEEKS}-week window)**: ${tw.value} / ${tw.threshold} ${checkmark(tw.passing)}`,
  );

  const wr = r.gates.weeklyRatio;
  lines.push(
    `- **Weekly wouldRejectRatio < ${(wr.threshold * 100).toFixed(0)}%**: ${checkmark(wr.passing)}`,
  );
  lines.push("");
  lines.push(`  | Week start | Writes | Unsupp/Rej | Ratio | Pass |`);
  lines.push(`  |------------|--------|------------|-------|------|`);
  for (const w of wr.perWeek) {
    const ratioStr = w.ratio === null ? "—" : `${(w.ratio * 100).toFixed(1)}%`;
    lines.push(
      `  | ${w.weekStart} | ${w.totalWrites} | ${w.unsupportedOrRejected} | ${ratioStr} | ${checkmark(w.passing)} |`,
    );
  }
  lines.push("");

  const sa = r.gates.searchAbstain;
  if (sa.applicable) {
    lines.push(
      `- **Search abstain ratio (30d) ≤ ${(sa.threshold * 100).toFixed(0)}%**: ` +
        `${(sa.value * 100).toFixed(1)}% ${checkmark(sa.passing)}`,
    );
  } else {
    lines.push(`- **Search abstain ratio (30d)**: skipped — ${sa.reason}`);
  }
  lines.push("");

  if (r.reasons.length > 0) {
    lines.push(`### Reasons`);
    lines.push("");
    for (const reason of r.reasons) {
      lines.push(`- ${reason}`);
    }
    lines.push("");
  }

  if (r.status === "ready" && !r.currentlyEnabled) {
    lines.push(
      `> All gates pass. To flip Phase 2b on, set ` +
        `\`AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED=true\` (env var) or ` +
        `\`evidence.reject_unsupported_writes: true\` in \`.agent-wiki.yaml\`. ` +
        `See [Phase 2b flip criteria](${FLIP_CRITERIA_URL}) ` +
        `for the rationale.`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate the report and optionally persist it. Returns the rendered
 * markdown so the MCP caller can also surface it inline. `writtenTo` is
 * set when `write: true`; callers that need it as a non-optional string
 * should null-check at the use site.
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
