import { describe, it, expect } from "vitest";
import {
  buildSearchEnvelope,
  downgradeForReadPage,
  ABSOLUTE_FLOOR,
} from "./evidence-search.js";
import type { SearchResult } from "./search.js";

function r(path: string, score: number): SearchResult {
  return { path, score, snippet: "" };
}

describe("buildSearchEnvelope", () => {
  it("returns absent + abstain on empty result list, with empty provenance", () => {
    const env = buildSearchEnvelope([], "anything");
    expect(env.confidence).toBe("absent");
    expect(env.abstain).toBe(true);
    expect(env.basis).toBe("unsupported");
    expect(env.provenance).toEqual([]);
  });

  it("abstains when top1 is below the absolute floor and clears provenance", () => {
    const env = buildSearchEnvelope(
      [r("a.md", ABSOLUTE_FLOOR - 0.1), r("b.md", 0.1)],
      "weak query",
    );
    expect(env.confidence).toBe("absent");
    expect(env.abstain).toBe(true);
    expect(env.provenance).toEqual([]);
    // Rationale still mentions what came back so a debugger can see it.
    expect(env.rationale).toMatch(/a\.md/);
    expect(env.rationale).toMatch(/absolute floor/);
  });

  it("returns strong when top1 dominates top2 (≥ 2× ratio)", () => {
    const env = buildSearchEnvelope([r("a.md", 10), r("b.md", 4)], "clear winner");
    expect(env.confidence).toBe("strong");
    expect(env.abstain).toBe(false);
    expect(env.basis).toBe("synthesized");
  });

  it("returns weak when top1 is close to top2 (< 2× ratio)", () => {
    const env = buildSearchEnvelope([r("a.md", 5), r("b.md", 4)], "ambiguous");
    expect(env.confidence).toBe("weak");
    expect(env.abstain).toBe(false);
    expect(env.rationale).toMatch(/multiple plausible/);
  });

  it("returns strong when there is only one result above the floor", () => {
    const env = buildSearchEnvelope([r("a.md", 5)], "single result");
    expect(env.confidence).toBe("strong");
  });

  it("populates provenance with up to top 3 wiki pages on non-abstain", () => {
    const results = [r("a.md", 10), r("b.md", 4), r("c.md", 3), r("d.md", 2)];
    const env = buildSearchEnvelope(results, "x");
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
    "test",
  );

  it("leaves envelope unchanged for grounded pages with sources", () => {
    const env = downgradeForReadPage(baseEnvelope, { sources: ["raw/x.md"] });
    expect(env.confidence).toBe(baseEnvelope.confidence);
    expect(env.rationale).toBe(baseEnvelope.rationale);
    expect(env.provenance).toEqual(baseEnvelope.provenance);
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

  it("drops two tiers when both flags fire (strong → absent), clearing provenance", () => {
    const env = downgradeForReadPage(baseEnvelope, { sources: [], legacyUnsupported: true });
    expect(env.confidence).toBe("absent");
    expect(env.abstain).toBe(true);
    expect(env.provenance).toEqual([]);
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

  it("ignores malformed lastEditISO and does not add a stale note", () => {
    const env = downgradeForReadPage(baseEnvelope, {
      sources: ["raw/x.md"],
      lastEditISO: "not-a-date",
    });
    expect(env.rationale).toBe(baseEnvelope.rationale);
  });
});
