import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

describe("field-lineage eval harness — DB2 column-pair fixture", () => {
  const fixtureDir = resolve(process.cwd(), "src/cobol/__tests__/fixtures/eval/db2-column-pairs");
  let report: EvalReport;
  beforeAll(() => {
    report = evaluateFieldLineage(fixtureDir);
  });

  it("perfectly grades DB2 cross-program column pairs (precision = recall = 1.0)", () => {
    expect(report.overall.precision).toBeCloseTo(1, 10);
    expect(report.overall.recall).toBeCloseTo(1, 10);
  });

  it("emits the table-level pair plus both column-level pairs", () => {
    const fam = report.families.db2;
    if (fam.skipped) throw new Error("db2 unexpectedly skipped");
    // 1 pair key + 2 column keys = 3 graded facts.
    expect(fam.expected).toBe(3);
    expect(fam.actual).toBe(3);
    expect(fam.truePositives).toBe(3);
  });

  it("does not light up unrelated families (no copybook reuse, no CALL-USING)", () => {
    const det = report.families.deterministic;
    const cb = report.families.callBound;
    if (det.skipped || cb.skipped) throw new Error("graded family unexpectedly skipped");
    expect(det.actual).toBe(0);
    expect(cb.actual).toBe(0);
  });
});

describe("field-lineage eval harness — REPLACING cohort fixture", () => {
  const fixtureDir = resolve(process.cwd(), "src/cobol/__tests__/fixtures/eval/replacing");
  let report: EvalReport;
  beforeAll(() => {
    report = evaluateFieldLineage(fixtureDir);
  });

  it("perfectly grades the REPLACING cohort (precision = recall = 1.0)", () => {
    expect(report.overall.precision).toBeCloseTo(1, 10);
    expect(report.overall.recall).toBeCloseTo(1, 10);
  });

  it("captures the post-substitution field name (CLIENT-ID) and untouched fields (ZIP-CODE) under one cohort", () => {
    const det = report.families.deterministic;
    if (det.skipped) throw new Error("deterministic unexpectedly skipped");
    // CUSTOMER-REC + CLIENT-ID + CUSTOMER-ADDRESS + ZIP-CODE = 4 entries.
    expect(det.expected).toBe(4);
    expect(det.actual).toBe(4);
    expect(det.truePositives).toBe(4);
    expect(det.falsePositives).toEqual([]);
    expect(det.falseNegatives).toEqual([]);
  });

  it("anchors against a Phase B regression: a builder that loses the REPLACING rename would surface CUSTOMER-ID as FP and CLIENT-ID as FN", () => {
    // Sanity check against the canonical-key shape — the manifest's CLIENT-ID
    // entry must be matched by the builder's emission of the renamed field,
    // not by an accidental match on the pre-substitution name.
    const det = report.families.deterministic;
    if (det.skipped) throw new Error("deterministic unexpectedly skipped");
    expect(det.falsePositives.find((k) => k.startsWith("CUSTOMER-ID|"))).toBeUndefined();
  });
});

describe("field-lineage eval harness — REPLACING + inferred (Phase C)", () => {
  // Phase C: candidate sourcing for inferred matching widens to include
  // REPLACING cohorts, but matches on the ORIGINAL (pre-substitution)
  // field shape. Projection is used only to gate out leaves whose name
  // was rewritten by REPLACING (no source-text backing for the matched
  // name). The fixture exercises both halves of the gate — see the
  // manifest description for the full setup.
  const fixtureDir = resolve(process.cwd(), "src/cobol/__tests__/fixtures/eval/replacing-inferred");
  let report: EvalReport;
  beforeAll(() => {
    report = evaluateFieldLineage(fixtureDir);
  });

  it("Phase C surfaces COMMON-ID and COMMON-NAME cross-copybook pairs (recall gain over pre-Phase-C)", () => {
    const ih = report.families.inferredHigh;
    if (ih.skipped) throw new Error("inferredHigh unexpectedly skipped");
    expect(ih.expected).toBe(2);
    expect(ih.actual).toBe(2);
    expect(ih.truePositives).toBe(2);
  });

  it("precision gate filters the REPLACING-laundered ENTITY-PK pair — both leaves came from substitution on different source names", () => {
    const ih = report.families.inferredHigh;
    if (ih.skipped) throw new Error("inferredHigh unexpectedly skipped");
    expect(ih.falsePositives).toEqual([]);
    // Sanity: ENTITY-PK is NOT in the actual emission set. If a future
    // regression dropped the gate, this assertion would fail loudly.
    expect(ih.falseNegatives).toEqual([]);
  });

  it("each REPLACING cohort still emits its full deterministic-via-replacing entry set (8 entries across the two copybooks)", () => {
    const det = report.families.deterministic;
    if (det.skipped) throw new Error("deterministic unexpectedly skipped");
    expect(det.expected).toBe(8);
    expect(det.actual).toBe(8);
    expect(det.truePositives).toBe(8);
  });

  it("overall fixture grades 1.0 / 1.0 after Phase C", () => {
    expect(report.overall.precision).toBeCloseTo(1, 10);
    expect(report.overall.recall).toBeCloseTo(1, 10);
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

  it("rejects invalid deterministic linkage values", () => {
    scratchDir = mkFixture(
      `version: 1\ndeterministic:\n  - fieldName: X\n    copybooks: [A]\n    programs: [P1, P2]\n    linkage: garbage\n`,
    );
    expect(() => evaluateFieldLineage(scratchDir)).toThrow(/linkage must be one of/);
  });

  it("rejects mixed-pin deterministic family (some entries pin linkage, others don't)", () => {
    scratchDir = mkFixture(
      `version: 1\ndeterministic:\n  - fieldName: X\n    copybooks: [A]\n    programs: [P1, P2]\n    linkage: deterministic\n  - fieldName: Y\n    copybooks: [A]\n    programs: [P1, P2]\n`,
    );
    expect(() => evaluateFieldLineage(scratchDir)).toThrow(/either ALL entries must pin linkage, or NONE/);
  });
});

describe("field-lineage eval harness — deterministic linkage-tier grading", () => {
  const basicFixture = resolve(process.cwd(), "src/cobol/__tests__/fixtures/eval/basic");
  const replacingFixture = resolve(process.cwd(), "src/cobol/__tests__/fixtures/eval/replacing");

  it("basic fixture's deterministic family scores 1.0 with tier=deterministic pinned", () => {
    const report = evaluateFieldLineage(basicFixture);
    const det = report.families.deterministic;
    if (det.skipped) throw new Error("deterministic unexpectedly skipped");
    expect(det.precision).toBeCloseTo(1, 10);
    expect(det.recall).toBeCloseTo(1, 10);
  });

  it("replacing fixture's deterministic family scores 1.0 with tier=deterministic-via-replacing pinned", () => {
    const report = evaluateFieldLineage(replacingFixture);
    const det = report.families.deterministic;
    if (det.skipped) throw new Error("deterministic unexpectedly skipped");
    expect(det.precision).toBeCloseTo(1, 10);
    expect(det.recall).toBeCloseTo(1, 10);
  });

  it("rejects swapped-tier manifest: a basic-style fixture with linkage=deterministic-via-replacing surfaces every entry as FP+FN", () => {
    // Write a clone of the basic fixture but with the WRONG tier pinned —
    // the builder emits `deterministic` (no REPLACING in the sources), so
    // every pinned-as-via-replacing manifest entry should land as FN, and
    // every emitted deterministic entry should land as FP. This is the
    // anchor that proves tier pinning works: the previous tier-agnostic
    // harness would have scored this 1.0/1.0.
    const dir = mkdtempSync(join(tmpdir(), "lineage-eval-tier-"));
    try {
      // Copy basic fixture's COBOL sources verbatim.
      const sources = [
        "CALLEE.cbl",
        "CALLER.cbl",
        "CLIENT-REC.cpy",
        "CLIENTA.cbl",
        "CUSTOMER-REC.cpy",
        "ORDERA.cbl",
        "ORDERB.cbl",
      ];
      for (const f of sources) {
        const src = readFileSync(join(basicFixture, f), "utf-8");
        writeFileSync(join(dir, f), src, "utf-8");
      }
      // Wrong-tier manifest: deterministic-via-replacing instead of deterministic.
      writeFileSync(
        join(dir, "lineage.expected.yaml"),
        `version: 1\ndeterministic:\n  - fieldName: CUSTOMER-REC\n    copybooks: [CUSTOMER-REC]\n    programs: [ORDERA, ORDERB]\n    linkage: deterministic-via-replacing\n  - fieldName: CUSTOMER-ID\n    copybooks: [CUSTOMER-REC]\n    programs: [ORDERA, ORDERB]\n    linkage: deterministic-via-replacing\n  - fieldName: CUSTOMER-NAME\n    copybooks: [CUSTOMER-REC]\n    programs: [ORDERA, ORDERB]\n    linkage: deterministic-via-replacing\n  - fieldName: CUSTOMER-ZIP\n    copybooks: [CUSTOMER-REC]\n    programs: [ORDERA, ORDERB]\n    linkage: deterministic-via-replacing\n`,
        "utf-8",
      );
      const report = evaluateFieldLineage(dir);
      const det = report.families.deterministic;
      if (det.skipped) throw new Error("deterministic unexpectedly skipped");
      // Every expected entry is FN (wrong tier), every actual entry is FP.
      expect(det.truePositives).toBe(0);
      expect(det.falseNegatives.length).toBe(4);
      expect(det.falsePositives.length).toBe(4);
      // The FN keys carry the wrong tier suffix; the FP keys carry the right one.
      expect(det.falseNegatives[0]).toContain("tier=deterministic-via-replacing");
      expect(det.falsePositives[0]).toContain("tier=deterministic");
      expect(det.falsePositives[0]).not.toContain("via-replacing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
