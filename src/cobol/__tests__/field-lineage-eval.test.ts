import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  evaluateFieldLineage,
  loadManifest,
  renderEvalReport,
  type EvalReport,
  type FamilyMetrics,
  type FamilyName,
  type FamilyResult,
} from "../field-lineage-eval.js";

const FIXTURE_DIR = resolve(process.cwd(), "src/cobol/__tests__/fixtures/eval/basic");

function metrics(report: EvalReport, family: FamilyName): FamilyMetrics {
  const fam = report.families[family];
  if (fam.skipped) throw new Error(`Family ${family} unexpectedly skipped`);
  return fam;
}

describe("field-lineage eval harness — basic fixture", () => {
  let report: EvalReport;
  beforeAll(() => {
    report = evaluateFieldLineage(FIXTURE_DIR);
  });

  it("perfectly grades the basic fixture (precision = recall = 1.0)", () => {
    expect(report.overall.precision).toBeCloseTo(1, 10);
    expect(report.overall.recall).toBeCloseTo(1, 10);
    expect(report.overall.f1).toBeCloseTo(1, 10);
  });

  it("exercises deterministic, inferredHigh, and callBound families with non-zero TP", () => {
    expect(metrics(report, "deterministic").truePositives).toBeGreaterThan(0);
    expect(metrics(report, "inferredHigh").truePositives).toBeGreaterThan(0);
    expect(metrics(report, "callBound").truePositives).toBeGreaterThan(0);
  });

  it("reports zero false positives and zero false negatives across graded families", () => {
    for (const family of Object.keys(report.families) as FamilyName[]) {
      const fam = report.families[family];
      if (fam.skipped) continue;
      expect(fam.falsePositives, `${family} false positives`).toEqual([]);
      expect(fam.falseNegatives, `${family} false negatives`).toEqual([]);
    }
  });

  it("does not skip any family declared in the manifest", () => {
    for (const family of Object.keys(report.families) as FamilyName[]) {
      expect(report.families[family].skipped, `${family} should not be skipped`).toBe(false);
    }
  });

  it("renders a markdown report containing the overall scoreline and per-family table", () => {
    const md = renderEvalReport(report);
    expect(md).toContain("Field-lineage eval");
    expect(md).toContain("Overall");
    expect(md).toContain("Deterministic shared copybook");
    expect(md).toContain("Inferred — high confidence");
    expect(md).toContain("CALL ... USING boundary");
    // Perfect run has no per-family FP/FN section.
    expect(md).not.toMatch(/^### .* — high confidence$/m);
    expect(md).not.toContain("**False positives**");
    expect(md).not.toContain("**False negatives**");
  });

  it("renders vacuous (manifest `[]` + zero emissions) families as '—', not 100%", () => {
    const md = renderEvalReport(report);
    // inferredAmbiguous, inferredSemantic, and db2 are declared `[]` in the
    // basic fixture and emit nothing — they must render with a `—` placeholder
    // so a reviewer can tell them apart from a real perfect-graded family.
    const ambiguousRow = md.split("\n").find((line) => line.startsWith("| Inferred — ambiguous |"));
    expect(ambiguousRow, "ambiguous row").toBeDefined();
    expect(ambiguousRow).toContain("| — |");
    expect(ambiguousRow).not.toContain("100.0%");
  });
});

describe("field-lineage eval harness — renderer edge cases", () => {
  it("emits a false-positive section in markdown when actual exceeds expected", () => {
    const report: EvalReport = {
      fixture: "synthetic",
      families: {
        deterministic: {
          skipped: false,
          expected: 1,
          actual: 2,
          truePositives: 1,
          falsePositives: ["EXTRA|cbs=X|pgs=A,B"],
          falseNegatives: [],
          precision: 0.5,
          recall: 1,
          f1: 2 / 3,
        },
        inferredHigh: { skipped: true },
        inferredAmbiguous: { skipped: true },
        inferredSemantic: { skipped: true },
        callBound: { skipped: true },
        db2: { skipped: true },
      },
      overall: { precision: 0.5, recall: 1, f1: 2 / 3 },
    };
    const md = renderEvalReport(report);
    expect(md).toContain("**False positives**");
    expect(md).toContain("EXTRA|cbs=X|pgs=A,B");
    expect(md).not.toContain("**False negatives**");
  });

  it("renders skipped families with '—' across metric cells, not 100%", () => {
    const report: EvalReport = {
      fixture: "skipped-only",
      families: {
        deterministic: { skipped: true },
        inferredHigh: { skipped: true },
        inferredAmbiguous: { skipped: true },
        inferredSemantic: { skipped: true },
        callBound: { skipped: true },
        db2: { skipped: true },
      },
      overall: { precision: 1, recall: 1, f1: 1 },
    };
    const md = renderEvalReport(report);
    // No graded family means no row should mention "100.0%" except the
    // overall scoreline, which is the only line outside the table.
    const rows = md.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Family |") && !line.startsWith("|---"));
    for (const row of rows) {
      expect(row, `skipped row should not show percentages: ${row}`).not.toContain("100.0%");
      expect(row).toContain("_skipped_");
    }
  });
});

describe("field-lineage eval harness — manifest validation", () => {
  let scratchDir: string;
  const created: string[] = [];

  function mkFixture(manifestYaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "lineage-eval-"));
    created.push(dir);
    // Mirror the basic fixture's COBOL sources so the build pipeline runs;
    // only the manifest varies per test. Single trivial COBOL file is enough
    // since manifest validation runs before any builder call.
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "STUB.cbl"),
      `       IDENTIFICATION DIVISION.\n       PROGRAM-ID. STUB.\n       PROCEDURE DIVISION.\n       A. STOP RUN.\n`,
      "utf-8",
    );
    writeFileSync(join(dir, "lineage.expected.yaml"), manifestYaml, "utf-8");
    return dir;
  }

  afterEach(() => {
    while (created.length > 0) {
      const dir = created.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects YAML-null family values with a clear schema error rather than crashing later", () => {
    scratchDir = mkFixture(`version: 1\ninferredAmbiguous:\n`);
    // YAML-null on a family is normalized to "skipped" — no crash.
    const report = evaluateFieldLineage(scratchDir);
    expect(report.families.inferredAmbiguous.skipped).toBe(true);
  });

  it("rejects non-array family values at load time, not deep in the grader", () => {
    scratchDir = mkFixture(`version: 1\ndeterministic: not-an-array\n`);
    expect(() => evaluateFieldLineage(scratchDir)).toThrow(/family 'deterministic' must be an array/);
  });

  it("rejects manifest entries missing required fields with a path-pointing error", () => {
    scratchDir = mkFixture(`version: 1\ndeterministic:\n  - fieldName: CUSTOMER-ID\n    programs: [ORDERA, ORDERB]\n`);
    expect(() => evaluateFieldLineage(scratchDir)).toThrow(/deterministic\[0\]\.copybooks/);
  });

  it("rejects unknown top-level keys instead of silently skipping a typo'd family", () => {
    scratchDir = mkFixture(`version: 1\ninferredHigj: []\n`);
    expect(() => evaluateFieldLineage(scratchDir)).toThrow(/unknown top-level key 'inferredHigj'/);
  });

  it("rejects unsupported manifest versions", () => {
    scratchDir = mkFixture(`version: 2\n`);
    expect(() => loadManifest(join(scratchDir, "lineage.expected.yaml"))).toThrow(/unsupported version 2/);
  });

  it("rejects inferred entries whose copybooks list is not exactly two", () => {
    scratchDir = mkFixture(
      `version: 1\ninferredHigh:\n  - fieldName: CUSTOMER-ID\n    copybooks: [A, B, C]\n`,
    );
    expect(() => evaluateFieldLineage(scratchDir)).toThrow(/inferredHigh\[0\]\.copybooks must list exactly two/);
  });

  it("rejects callBound entries missing both callerField and callerQualified", () => {
    scratchDir = mkFixture(
      `version: 1\ncallBound:\n  - caller: C\n    callee: E\n    position: 0\n    calleeField: LK\n`,
    );
    expect(() => evaluateFieldLineage(scratchDir)).toThrow(/callerField or callerQualified/);
  });

  it("rejects duplicate canonical keys in the manifest (e.g. same deterministic entry twice)", () => {
    scratchDir = mkFixture(
      `version: 1\ndeterministic:\n  - fieldName: X\n    copybooks: [A]\n    programs: [P1, P2]\n  - fieldName: X\n    copybooks: [A]\n    programs: [P1, P2]\n`,
    );
    expect(() => evaluateFieldLineage(scratchDir)).toThrow(/Duplicate deterministic .* entries/);
  });

  it("rejects empty identifier strings instead of silently producing degenerate canonical keys", () => {
    scratchDir = mkFixture(
      `version: 1\ndeterministic:\n  - fieldName: ""\n    copybooks: [A]\n    programs: [P1, P2]\n`,
    );
    expect(() => evaluateFieldLineage(scratchDir)).toThrow(/must be a non-empty string/);
  });

  it("rejects empty arrays in deterministic identifier fields", () => {
    scratchDir = mkFixture(
      `version: 1\ndeterministic:\n  - fieldName: X\n    copybooks: []\n    programs: [P1, P2]\n`,
    );
    expect(() => evaluateFieldLineage(scratchDir)).toThrow(/copybooks must list at least one copybook/);
  });

  it("rejects fewer-than-two programs on a deterministic entry (deterministic emission needs ≥2 consumers)", () => {
    scratchDir = mkFixture(
      `version: 1\ndeterministic:\n  - fieldName: X\n    copybooks: [A]\n    programs: [P1]\n`,
    );
    expect(() => evaluateFieldLineage(scratchDir)).toThrow(/programs must list at least two programs/);
  });

  it("rejects non-integer callBound position", () => {
    scratchDir = mkFixture(
      `version: 1\ncallBound:\n  - caller: C\n    callee: E\n    position: 0.5\n    callerField: WS\n    calleeField: LK\n`,
    );
    expect(() => evaluateFieldLineage(scratchDir)).toThrow(/position must be a non-negative integer/);
  });

  it("rejects mixed callerField+callerQualified on the same callBound entry", () => {
    scratchDir = mkFixture(
      `version: 1\ncallBound:\n  - caller: C\n    callee: E\n    position: 0\n    callerField: WS\n    callerQualified: WS.X\n    calleeField: LK\n`,
    );
    expect(() => evaluateFieldLineage(scratchDir)).toThrow(/callerField OR callerQualified, not both/);
  });

  it("rejects asymmetric per-side pinning (callerField + calleeQualified)", () => {
    scratchDir = mkFixture(
      `version: 1\ncallBound:\n  - caller: C\n    callee: E\n    position: 0\n    callerField: WS\n    calleeQualified: LK.Y\n`,
    );
    expect(() => evaluateFieldLineage(scratchDir)).toThrow(/same pinning mode on both sides/);
  });

  it("rejects mixed-pin inferred family (some entries pin qualifiedNames, others don't)", () => {
    scratchDir = mkFixture(
      `version: 1\ninferredHigh:\n  - fieldName: A\n    copybooks: [X, Y]\n    qualifiedNames: [X.A, Y.A]\n  - fieldName: B\n    copybooks: [X, Y]\n`,
    );
    expect(() => evaluateFieldLineage(scratchDir)).toThrow(/either ALL entries must pin qualifiedNames, or NONE/);
  });

  it("rejects YAML-null on db2 columnPairs (ambiguous vs `[]` and omitted)", () => {
    scratchDir = mkFixture(
      `version: 1\ndb2:\n  - table: T\n    writer: W\n    reader: R\n    columnPairs:\n`,
    );
    expect(() => evaluateFieldLineage(scratchDir)).toThrow(/columnPairs must be an array/);
  });

  it("prefixes per-entry validation errors with the manifest path", () => {
    scratchDir = mkFixture(
      `version: 1\ndeterministic:\n  - fieldName: 42\n    copybooks: [A]\n    programs: [P1, P2]\n`,
    );
    expect(() => evaluateFieldLineage(scratchDir)).toThrow(/Manifest .*lineage\.expected\.yaml:.*fieldName must be a string/);
  });
});
