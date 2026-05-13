import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wiki } from "./wiki.js";
import {
  appendUnsupportedWriteEvent,
  appendWriteEvent,
} from "./evidence-write-log.js";
import { appendSearchEvent } from "./evidence-search-log.js";
import {
  buildEvidenceReport,
  renderEvidenceReport,
  runEvidenceReport,
} from "./evidence-report.js";

let testRoot: string;
function freshWiki(): Wiki {
  return Wiki.init(testRoot);
}

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "evidence-report-"));
});
afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("buildEvidenceReport — source coverage", () => {
  it("empty wiki returns zeros across the board", () => {
    const wiki = freshWiki();
    const report = buildEvidenceReport(wiki);
    expect(report.source).toEqual({
      total: 0,
      grounded: 0,
      synthesis: 0,
      unsupported: 0,
      legacyUnsupported: 0,
      other: 0,
    });
  });

  it("excludes system pages (index/log/timeline) from the tally", () => {
    const wiki = freshWiki();
    // Wiki.init plants index.md, log.md, timeline.md — they should NOT count.
    const report = buildEvidenceReport(wiki);
    expect(report.source.total).toBe(0);
  });

  it("classifies grounded, synthesis, unsupported, and legacy correctly", () => {
    const wiki = freshWiki();
    wiki.write("g.md", "---\ntitle: G\nsources: [raw/x.md]\n---\nGrounded.");
    wiki.write("s1.md", "---\ntitle: S\nsynthesis: true\n---\nAggregated.");
    wiki.write("s2.md", "---\ntitle: S\ntype: synthesis\n---\nAggregated.");
    wiki.write("u.md", "---\ntitle: U\n---\nUnsupported.");
    wiki.write("legacy.md", "---\ntitle: L\nlegacyUnsupported: true\n---\nOld page.");
    const report = buildEvidenceReport(wiki);
    expect(report.source).toEqual({
      total: 5,
      grounded: 1,
      synthesis: 2,
      unsupported: 1,
      legacyUnsupported: 1,
      other: 0,
    });
  });

  it("counts a synthesis page with sources as synthesis (not double-counted)", () => {
    const wiki = freshWiki();
    wiki.write(
      "syn-with-sources.md",
      "---\ntitle: SS\nsynthesis: true\nsources: [raw/x.md]\n---\nBoth.",
    );
    const report = buildEvidenceReport(wiki);
    expect(report.source.synthesis).toBe(1);
    expect(report.source.grounded).toBe(0);
    expect(report.source.total).toBe(1);
  });

  it("buckets a page with no classification flags into 'other'", () => {
    const wiki = freshWiki();
    // Bypass evidence classification at write time so the page lands on
    // disk without `unsupported: true` being stamped — simulating a page
    // produced by an internal/migration code path that didn't go through
    // the classifier. The report must surface this as 'other' so the
    // operator notices unaccounted-for pages.
    wiki.write(
      "weird.md",
      "---\ntitle: W\n---\nNo classification flags at all.",
      "test",
      { _bypassEvidenceClassification: true },
    );
    const report = buildEvidenceReport(wiki);
    expect(report.source.other).toBe(1);
    expect(report.source.total).toBe(1);
  });

  it("counts a page with malformed frontmatter as 'other' instead of crashing", () => {
    const wiki = freshWiki();
    // Write garbage frontmatter directly to disk — wiki.write would have
    // sanitized it. The report aggregator must tolerate this and not let
    // one corrupt page break the whole report.
    const fullPath = join(wiki.config.wikiDir, "broken.md");
    writeFileSync(
      fullPath,
      "---\nthis is :: invalid:\n  - yaml: [unbalanced\n---\nbody.",
    );
    const report = buildEvidenceReport(wiki);
    expect(report.source.other).toBe(1);
    expect(report.source.total).toBe(1);
  });
});

describe("buildEvidenceReport — COBOL lineage", () => {
  it("returns empty lineage when no field-lineage.json artifact exists", () => {
    const wiki = freshWiki();
    const report = buildEvidenceReport(wiki);
    expect(report.lineage).toEqual({});
  });

  it("aggregates callBound and db2 summaries when the artifact exists", () => {
    const wiki = freshWiki();
    const dir = join(wiki.config.rawDir, "parsed", "cobol");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "field-lineage.json"),
      JSON.stringify({
        callBoundLineage: {
          summary: {
            callSites: 7,
            pairs: 12,
            diagnosticsByKind: {
              "unresolved-callee": 2,
              "dynamic-call": 1,
              "shape-mismatch": 0,
            },
          },
        },
        db2Lineage: {
          summary: {
            sharedTables: 3,
            pairs: 5,
            diagnosticsByKind: {
              "self-loop": 1,
              "host-var-unresolved": 4,
            },
          },
        },
      }),
    );
    const report = buildEvidenceReport(wiki);
    expect(report.lineage.callBound).toEqual({
      callSites: 7,
      pairs: 12,
      diagnosticsByKind: {
        "unresolved-callee": 2,
        "dynamic-call": 1,
        "shape-mismatch": 0,
      },
      totalDiagnostics: 3,
    });
    expect(report.lineage.db2).toEqual({
      sharedTables: 3,
      pairs: 5,
      diagnosticsByKind: {
        "self-loop": 1,
        "host-var-unresolved": 4,
      },
      totalDiagnostics: 5,
    });
  });

  it("surfaces top-level field-lineage diagnostics (#30)", () => {
    const wiki = freshWiki();
    const dir = join(wiki.config.rawDir, "parsed", "cobol");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "field-lineage.json"),
      JSON.stringify({
        summary: {
          deterministic: { copybooks: 0, programs: 0, fields: 0 },
          inferred: { copybooks: 0, programs: 0, highConfidence: 0, ambiguous: 0 },
          diagnosticsByKind: { "parsed-zero-data-items": 3 },
        },
        diagnostics: [
          { kind: "parsed-zero-data-items", sourceFile: "A.cpy", isCopybook: true, rationale: "..." },
          { kind: "parsed-zero-data-items", sourceFile: "B.cpy", isCopybook: true, rationale: "..." },
          { kind: "parsed-zero-data-items", sourceFile: "C.cpy", isCopybook: true, rationale: "..." },
        ],
      }),
    );
    const report = buildEvidenceReport(wiki);
    expect(report.lineage.fieldLineage).toEqual({
      diagnosticsByKind: { "parsed-zero-data-items": 3 },
      totalDiagnostics: 3,
    });
  });

  it("omits fieldLineage section when diagnosticsByKind is all zero (#30)", () => {
    // Defensive: a healthy corpus carries the field with zero counts. The
    // report should treat it as "no findings to surface" rather than rendering
    // an empty subsection.
    const wiki = freshWiki();
    const dir = join(wiki.config.rawDir, "parsed", "cobol");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "field-lineage.json"),
      JSON.stringify({
        summary: {
          diagnosticsByKind: { "parsed-zero-data-items": 0 },
        },
      }),
    );
    const report = buildEvidenceReport(wiki);
    expect(report.lineage.fieldLineage).toBeUndefined();
  });

  it("tolerates malformed field-lineage.json without throwing", () => {
    const wiki = freshWiki();
    const dir = join(wiki.config.rawDir, "parsed", "cobol");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "field-lineage.json"), "{ not valid json");
    const report = buildEvidenceReport(wiki);
    expect(report.lineage).toEqual({});
  });
});

describe("buildEvidenceReport — trend (4 weeks)", () => {
  it("returns 4 buckets even when the counter file is empty", () => {
    const wiki = freshWiki();
    const report = buildEvidenceReport(wiki, new Date("2026-05-08T00:00:00.000Z"));
    expect(report.trend).toHaveLength(4);
    expect(report.trend.every((b) => b.totalWrites === 0)).toBe(true);
    expect(report.trend.every((b) => b.unsupportedOrRejected === 0)).toBe(true);
  });

  it("buckets counter events into the correct week", () => {
    const wiki = freshWiki();
    const now = new Date("2026-05-08T00:00:00.000Z");
    // Week 0 (most recent — 2026-05-01 → 2026-05-08): 2 grounded, 1 unsupported
    appendWriteEvent(wiki.config.workspace, "grounded",    "2026-05-02T00:00:00.000Z");
    appendWriteEvent(wiki.config.workspace, "grounded",    "2026-05-03T00:00:00.000Z");
    appendWriteEvent(wiki.config.workspace, "unsupported", "2026-05-04T00:00:00.000Z");
    // Week -1 (2026-04-24 → 2026-05-01): 1 rejected
    appendWriteEvent(wiki.config.workspace, "rejected",    "2026-04-26T00:00:00.000Z");
    // Week -3 (2026-04-10 → 2026-04-17): 1 grounded
    appendWriteEvent(wiki.config.workspace, "grounded",    "2026-04-12T00:00:00.000Z");
    const report = buildEvidenceReport(wiki, now);
    // Buckets are returned oldest-first; index 3 is the most recent week.
    expect(report.trend[3]).toMatchObject({
      totalWrites: 3,
      unsupportedOrRejected: 1,
    });
    expect(report.trend[2]).toMatchObject({
      totalWrites: 1,
      unsupportedOrRejected: 1,
    });
    expect(report.trend[1]).toMatchObject({
      totalWrites: 0,
      unsupportedOrRejected: 0,
    });
    expect(report.trend[0]).toMatchObject({
      totalWrites: 1,
      unsupportedOrRejected: 0,
    });
  });

  it("does not fall back to the unsupported log — pre-counter weeks show 0/0", () => {
    const wiki = freshWiki();
    const now = new Date("2026-05-08T00:00:00.000Z");
    // Old unsupported log entries with no counter activity. A per-week
    // fallback would show "2 unsupported / 0 writes" — confusing. We
    // intentionally show 0/0 instead and let the counter catch up over
    // the next 4 weeks.
    appendUnsupportedWriteEvent(wiki.config.workspace, {
      page: "a.md", timestamp: "2026-05-02T00:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    appendUnsupportedWriteEvent(wiki.config.workspace, {
      page: "b.md", timestamp: "2026-05-03T00:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    const report = buildEvidenceReport(wiki, now);
    expect(report.trend.every((b) => b.totalWrites === 0)).toBe(true);
    expect(report.trend.every((b) => b.unsupportedOrRejected === 0)).toBe(true);
  });
});

describe("buildEvidenceReport — search trust", () => {
  it("returns zeros and null ratio when the search log is empty", () => {
    const wiki = freshWiki();
    const report = buildEvidenceReport(wiki);
    expect(report.searchTrust).toEqual({
      totalSearches: 0,
      abstainCount: 0,
      abstainRatio: null,
      medianTop1Score: null,
      ratioHistogram: { lt15: 0, lt20: 0, lt30: 0, ge30: 0 },
    });
  });

  it("computes abstain ratio + median top1 + ratio histogram from the log", () => {
    const wiki = freshWiki();
    const ts = (n: number) =>
      new Date(2026, 4, 1 + n, 0, 0, 0).toISOString();
    // 5 searches: 1 no-results, 1 below-floor, 3 normal hits.
    appendSearchEvent(wiki.config.workspace, {
      timestamp: ts(0), abstainReason: "no-results",
      top1Score: null, top1Top2Ratio: null, confidence: "absent",
    });
    appendSearchEvent(wiki.config.workspace, {
      timestamp: ts(1), abstainReason: "below-floor",
      top1Score: 1.2, top1Top2Ratio: null, confidence: "absent",
    });
    appendSearchEvent(wiki.config.workspace, {
      timestamp: ts(2), abstainReason: null,
      top1Score: 3.0, top1Top2Ratio: 1.2, confidence: "weak",
    });
    appendSearchEvent(wiki.config.workspace, {
      timestamp: ts(3), abstainReason: null,
      top1Score: 5.0, top1Top2Ratio: 2.5, confidence: "strong",
    });
    appendSearchEvent(wiki.config.workspace, {
      timestamp: ts(4), abstainReason: null,
      top1Score: 8.0, top1Top2Ratio: 4.0, confidence: "strong",
    });
    const report = buildEvidenceReport(wiki, new Date(2026, 4, 10));
    expect(report.searchTrust.totalSearches).toBe(5);
    expect(report.searchTrust.abstainCount).toBe(2);
    expect(report.searchTrust.abstainRatio).toBeCloseTo(0.4);
    // Top1 scores present: [1.2, 3.0, 5.0, 8.0] → median = (3.0+5.0)/2 = 4.0
    expect(report.searchTrust.medianTop1Score).toBeCloseTo(4.0);
    // Ratios: 1.2 → lt15; 2.5 → lt30; 4.0 → ge30. Single-result entries
    // (top1Top2Ratio: null) are excluded from the histogram.
    expect(report.searchTrust.ratioHistogram).toEqual({
      lt15: 1, lt20: 0, lt30: 1, ge30: 1,
    });
  });
});

describe("renderEvidenceReport — Markdown output", () => {
  it("renders the four sections with section headers", () => {
    const wiki = freshWiki();
    const md = renderEvidenceReport(buildEvidenceReport(wiki));
    expect(md).toContain("# Evidence Report");
    expect(md).toContain("## Source coverage");
    expect(md).toContain("## Search trust");
    expect(md).toContain("## Lineage diagnostic surfacing");
    expect(md).toContain("## Trend (last 4 weeks)");
  });

  it("Search trust falls back to a 'no activity' note when the search log is empty", () => {
    const wiki = freshWiki();
    const md = renderEvidenceReport(buildEvidenceReport(wiki));
    expect(md).toMatch(/No search activity in the last 30 days/);
  });

  it("includes percentage breakdowns in the source coverage section", () => {
    const wiki = freshWiki();
    wiki.write("g.md", "---\ntitle: G\nsources: [raw/x.md]\n---\nGrounded.");
    wiki.write("u.md", "---\ntitle: U\n---\nUnsupported.");
    const md = renderEvidenceReport(buildEvidenceReport(wiki));
    expect(md).toMatch(/1 grounded.*50\.0%/);
    expect(md).toMatch(/1 unsupported.*50\.0%/);
  });

  it("falls back to a 'no activity' line when all 4 weeks of trend are empty", () => {
    const wiki = freshWiki();
    const md = renderEvidenceReport(buildEvidenceReport(wiki));
    expect(md).toMatch(/No write activity in the last 4 weeks/);
  });

  it("renders a per-week table when trend has activity", () => {
    const wiki = freshWiki();
    appendWriteEvent(wiki.config.workspace, "grounded", "2026-05-02T00:00:00.000Z");
    const md = renderEvidenceReport(
      buildEvidenceReport(wiki, new Date("2026-05-08T00:00:00.000Z")),
    );
    expect(md).toContain("| Week start | Total writes | Unsupported-or-rejected |");
    expect(md).toMatch(/\| 2026-05-01 \| 1 \| 0 \|/);
  });
});

describe("runEvidenceReport — write flag", () => {
  it("does not write to disk when write=false", () => {
    const wiki = freshWiki();
    const result = runEvidenceReport(wiki, { write: false });
    expect(result.writtenTo).toBeUndefined();
    expect(existsSync(join(wiki.config.wikiDir, "evidence-report.md"))).toBe(false);
  });

  it("persists wiki/evidence-report.md with synthesis frontmatter when write=true", () => {
    const wiki = freshWiki();
    const result = runEvidenceReport(wiki, { write: true });
    expect(result.writtenTo).toBeDefined();
    const target = join(wiki.config.wikiDir, "evidence-report.md");
    expect(existsSync(target)).toBe(true);
    const content = readFileSync(target, "utf-8");
    // Synthesis frontmatter — keeps the page out of the unsupported tally
    // when wiki_admin rebuild later touches it.
    expect(content).toContain("synthesis: true");
    expect(content).toContain("# Evidence Report");
  });

  it("does not count evidence-report.md in its own source-coverage tally", () => {
    // Regression pin: evidence-report.md is the report's own output and
    // would otherwise be classified as a synthesis page (synthesis: true
    // frontmatter), inflating the very metric the report publishes. The
    // fix is to exclude it from SYSTEM_PAGE_NAMES; this test guards
    // against a future re-introduction.
    const wiki = freshWiki();
    runEvidenceReport(wiki, { write: true });
    const report = buildEvidenceReport(wiki);
    expect(report.source.total).toBe(0);
    expect(report.source.synthesis).toBe(0);
  });

  it("refuses to delete evidence-report.md (system-page guard)", () => {
    // evidence-report.md is auto-regenerated by runEvidenceReport; deleting
    // via wiki.delete should be blocked the same way index.md / log.md /
    // timeline.md are. The guard fires before the existence check, so
    // we don't need to actually write the file first — this isolates
    // the test to the system-page guard itself.
    const wiki = freshWiki();
    expect(() => wiki.delete("evidence-report.md")).toThrow(
      /Cannot delete system page/,
    );
  });
});
