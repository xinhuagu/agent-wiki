import { describe, it, expect } from "vitest";
import {
  buildSearchEnvelope,
  computeSearchDistribution,
  downgradeForReadPage,
  ABSOLUTE_FLOOR,
  SMALL_CORPUS_THRESHOLD,
} from "./evidence-search.js";
import type { SearchResult } from "./search.js";
import type { CorpusSearchStats } from "./evidence-search.js";

function r(path: string, score: number): SearchResult {
  return { path, score, snippet: "" };
}

describe("buildSearchEnvelope", () => {
  it("returns absent + abstain on empty result list", () => {
    const env = buildSearchEnvelope([], null, "anything");
    expect(env.confidence).toBe("absent");
    expect(env.abstain).toBe(true);
    expect(env.basis).toBe("unsupported");
    expect(env.provenance).toEqual([]);
  });

  it("abstains when top1 is below the absolute floor regardless of stats", () => {
    const env = buildSearchEnvelope([r("a.md", ABSOLUTE_FLOOR - 0.1)], null, "weak query");
    expect(env.confidence).toBe("absent");
    expect(env.abstain).toBe(true);
    expect(env.rationale).toMatch(/absolute floor/);
  });

  it("abstains when top1 is below the corpus 30th percentile (large corpus)", () => {
    const stats: CorpusSearchStats = {
      p30: 5.0,
      indexedPages: SMALL_CORPUS_THRESHOLD + 5,
      computedAt: new Date().toISOString(),
    };
    const env = buildSearchEnvelope([r("a.md", 4.5)], stats, "below percentile");
    expect(env.confidence).toBe("absent");
    expect(env.abstain).toBe(true);
    expect(env.rationale).toMatch(/percentile/);
  });

  it("ignores corpus percentile on a small corpus and falls back to absolute floor only", () => {
    const stats: CorpusSearchStats = {
      p30: 10.0, // would normally classify a 5.0 score as absent
      indexedPages: SMALL_CORPUS_THRESHOLD - 1, // too small
      computedAt: new Date().toISOString(),
    };
    const env = buildSearchEnvelope([r("a.md", 5.0), r("b.md", 1.0)], stats, "small corpus");
    // 5.0 is above absolute floor, percentile is ignored — should NOT abstain.
    expect(env.abstain).toBe(false);
    expect(env.confidence).not.toBe("absent");
  });

  it("returns strong when top1 dominates top2 (≥ 2× ratio)", () => {
    const env = buildSearchEnvelope([r("a.md", 10), r("b.md", 4)], null, "clear winner");
    expect(env.confidence).toBe("strong");
    expect(env.abstain).toBe(false);
    expect(env.basis).toBe("synthesized");
  });

  it("returns weak when top1 is close to top2 (< 2× ratio)", () => {
    const env = buildSearchEnvelope([r("a.md", 5), r("b.md", 4)], null, "ambiguous");
    expect(env.confidence).toBe("weak");
    expect(env.abstain).toBe(false);
    expect(env.rationale).toMatch(/multiple plausible/);
  });

  it("returns strong when there is only one result above the floor", () => {
    const env = buildSearchEnvelope([r("a.md", 5)], null, "single result");
    // ratio = Infinity, treated as strong
    expect(env.confidence).toBe("strong");
  });

  it("populates provenance with up to top 3 wiki pages", () => {
    const results = [r("a.md", 10), r("b.md", 4), r("c.md", 3), r("d.md", 2)];
    const env = buildSearchEnvelope(results, null, "x");
    expect(env.provenance).toHaveLength(3);
    expect(env.provenance.map((p) => p.wikiPage)).toEqual([
      "wiki/a.md",
      "wiki/b.md",
      "wiki/c.md",
    ]);
  });
});

describe("downgradeForReadPage", () => {
  const baseEnvelope = buildSearchEnvelope(
    [{ path: "p.md", score: 10, snippet: "" }, { path: "q.md", score: 4, snippet: "" }],
    null,
    "test",
  );

  it("leaves envelope unchanged for grounded pages with sources", () => {
    const env = downgradeForReadPage(baseEnvelope, { sources: ["raw/x.md"] });
    expect(env.confidence).toBe(baseEnvelope.confidence);
    expect(env.rationale).toBe(baseEnvelope.rationale);
  });

  it("leaves envelope unchanged for explicit synthesis pages without sources", () => {
    const env = downgradeForReadPage(baseEnvelope, { sources: [], synthesis: true });
    expect(env.confidence).toBe(baseEnvelope.confidence);
  });

  it("drops one tier for unsupported pages (no sources, no synthesis)", () => {
    const env = downgradeForReadPage(baseEnvelope, { sources: [] });
    expect(env.confidence).toBe("weak"); // strong → weak
    expect(env.rationale).toMatch(/no sources/);
  });

  it("drops one tier for legacyUnsupported pages", () => {
    const env = downgradeForReadPage(baseEnvelope, {
      sources: ["raw/x.md"],
      legacyUnsupported: true,
    });
    expect(env.confidence).toBe("weak");
    expect(env.rationale).toMatch(/legacyUnsupported/);
  });

  it("drops two tiers when both unsupported and legacy flags fire (strong → absent)", () => {
    const env = downgradeForReadPage(baseEnvelope, { sources: [], legacyUnsupported: true });
    expect(env.confidence).toBe("absent");
    expect(env.abstain).toBe(true);
  });

  it("notes stale page in rationale without changing tier", () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const env = downgradeForReadPage(baseEnvelope, {
      sources: ["raw/x.md"],
      lastEditISO: oldDate,
    });
    expect(env.confidence).toBe(baseEnvelope.confidence);
    expect(env.rationale).toMatch(/last edited \d+ days ago/);
  });
});

describe("computeSearchDistribution", () => {
  it("returns null p30 on a small corpus, even with high scores", () => {
    const titles = ["a", "b", "c", "d", "e"];
    const stats = computeSearchDistribution(titles, () => [{ score: 100 }]);
    expect(stats.p30).toBeNull();
    expect(stats.indexedPages).toBe(5);
  });

  it("computes a percentile when corpus is large enough", () => {
    const n = SMALL_CORPUS_THRESHOLD + 30;
    const titles = Array.from({ length: n }, (_, i) => `page-${i}`);
    // Scores cycle 1..10 deterministically
    const stats = computeSearchDistribution(titles, (q) => {
      const i = parseInt(q.split("-")[1] ?? "0", 10);
      return [{ score: (i % 10) + 1 }];
    });
    expect(stats.p30).not.toBeNull();
    expect(stats.indexedPages).toBe(n);
    // p30 is the 30th percentile of the sorted top1 score sample,
    // bounded between min and max scores observed.
    expect(stats.p30!).toBeGreaterThanOrEqual(1);
    expect(stats.p30!).toBeLessThanOrEqual(10);
  });

  it("returns null p30 when all queries return empty", () => {
    const titles = Array.from({ length: SMALL_CORPUS_THRESHOLD + 5 }, (_, i) => `page-${i}`);
    const stats = computeSearchDistribution(titles, () => []);
    expect(stats.p30).toBeNull();
  });
});
