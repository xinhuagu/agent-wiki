import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderDogfood, runDogfood } from "../dogfood-lineage.js";

const CORPUS_DIR = resolve(process.cwd(), "src/cobol/__tests__/corpora/ccvs-replacing-subset");
const BASELINE_PATH = resolve(CORPUS_DIR, "baseline-inferred-high.txt");

describe("NIST CCVS dogfood — inferred-high emission baseline", () => {
  // Regression anchor: the per-fixture eval tests pin "did the manifest's
  // declared facts emit," but they don't catch "did the builder start
  // emitting something the manifest doesn't pin." The dogfood corpus
  // covers that — any change to inferred candidate sourcing, gates, or
  // matching logic shows up as a baseline diff. When the diff is
  // intentional, regenerate the baseline (see corpus README).
  it("inferred-high emission matches the committed baseline", () => {
    const report = runDogfood(CORPUS_DIR);
    const actual = renderDogfood(report);
    const baseline = readFileSync(BASELINE_PATH, "utf-8");
    expect(actual).toBe(baseline);
  });

  it("baseline is non-empty — the test would catch a recall regression to zero", () => {
    // Without this check, a code change that silently drops all inferred
    // matches plus a stale baseline would both equal "" and pass the
    // primary assertion. Pin a floor.
    const baseline = readFileSync(BASELINE_PATH, "utf-8");
    expect(baseline).toMatch(/^# inferred-high pairs: [1-9]\d*$/m);
  });
});
