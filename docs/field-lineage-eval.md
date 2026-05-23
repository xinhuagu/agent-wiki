# Field-lineage eval harness

A minimal precision / recall yardstick for the three COBOL field-lineage
families: shared-copybook reuse (deterministic + inferred), `CALL ... USING`
boundary pairing, and shared-DB2-table cross-program flow. Lets tier
threshold changes (Phase C, semantic gates, dynamic-call resolver tweaks,
DB2 column-pair recall) be evaluated against ground-truth fixtures
instead of by inspection.

## Why

Every lineage tier the builder emits — `deterministic`, `inferredHigh`,
`inferredAmbiguous`, `inferredSemantic`, `callBound`, `db2` — has been
tuned via spot-check on hand-authored unit fixtures. There's been no
corpus-level "did this change improve recall without burning precision"
signal. The harness in `src/cobol/field-lineage-eval.ts` runs the full
build pipeline against a fixture directory, compares each family's
emitted entries to a YAML manifest, and reports per-family P/R/F1
plus the offending false-positive / false-negative keys.

## Where things live

- `src/cobol/field-lineage-eval.ts` — evaluator + markdown renderer
- `src/cobol/__tests__/field-lineage-eval.test.ts` — vitest entry point
- `src/cobol/__tests__/fixtures/eval/basic/` — first fixture corpus
  - `*.cbl` / `*.cpy` — real COBOL sources fed to `parse` →
    `extractModel` → `build*Lineage`
  - `lineage.expected.yaml` — ground-truth manifest

## Manifest schema (v1)

```yaml
version: 1
description: "Optional human-readable summary"

# Each family is optional. A family absent (or YAML-null) is *skipped*
# (not graded). A family present as `[]` is graded strictly — any emitted
# entry counts as a false positive. Unknown top-level keys are rejected
# at load time so typo'd family names don't silently degrade to skipped.

deterministic:
  - fieldName: CUSTOMER-ID
    copybooks: [CUSTOMER-REC]     # logical names, no "copybook:" prefix
    programs:  [ORDERA, ORDERB]   # program IDs, no "program:" prefix
    # Optional linkage-tier pin. Either ALL deterministic entries pin
    # `linkage`, or NONE do. When pinned, the canonical key includes the
    # tier — a builder regression that emits the right field name under
    # the wrong tier (e.g. plain `deterministic` instead of
    # `deterministic-via-replacing`, losing the `replacing` evidence)
    # lands as FN+FP. Values: `deterministic` | `deterministic-via-replacing`.
    linkage: deterministic

inferredHigh:
  - fieldName: CUSTOMER-ID
    copybooks: [CUSTOMER-REC, CLIENT-REC]   # pair (exactly two)
    # Optional — pin the qualified paths when a leaf name repeats under
    # different parents. If ANY entry in the family pins qualifiedNames,
    # all entries are graded by qualified path; otherwise grading is by
    # (fieldName, copybooks) only.
    # qualifiedNames: [CUSTOMER-REC.CUSTOMER-ID, CLIENT-REC.CUSTOMER-ID]

inferredAmbiguous: []
inferredSemantic: []

callBound:
  - caller: CALLER
    callee: CALLEE
    position: 0                   # 0-indexed
    callerField: WS-CUST-ID       # leaf name (or use callerQualified for nested)
    calleeField: LK-CUST-ID
    # callerQualified / calleeQualified — pin qualified paths when the
    # CALL boundary involves nested children. Mirrors the inferred-family
    # rule: any qualified pin in the family switches the whole family to
    # qualified-path grading.
    # Optional confidence-tier pin. Either ALL callBound entries pin
    # `confidence`, or NONE do. When pinned, the canonical key includes
    # the tier — a builder regression that emits the right pair under
    # the wrong tier (e.g. a `deterministic` shape-match landing as
    # `high`, losing pictureMatch evidence) lands as FN+FP. Values:
    # `deterministic` | `high`.
    confidence: deterministic

db2:
  - table: CUSTOMER
    writer: PROG-INS
    reader: PROG-SEL
    # `columnPairs` is opt-in: omitting it grades only the (table, writer,
    # reader) pair and ignores any column pairs the builder emits.
    # Declaring `columnPairs: []` or a non-empty list grades column
    # pairs strictly — emitted column pairs not listed become FPs.
    columnPairs:
      - column: CUST_ID
        writerHostVar: WS-CUST-ID
        readerHostVar: WS-OUT-CUST-ID
```

All identifier comparisons are case-insensitive and order-independent for
set-valued fields (`copybooks`, `programs`). Each manifest fact maps to
one canonical key; the actual builder's emission is converted to the same
key shape, and the two key sets are diffed.

### Validation

`loadManifest` validates at load time:

- `version: 1` (rejects other values — string `"1"` is NOT accepted; quote-strip in your editor).
- Unknown top-level keys are rejected.
- Per-family arrays must be arrays of objects with the required fields typed correctly (string for identifier fields, finite number for `position`, exactly-two-element array for inferred `copybooks`).
- Duplicate canonical keys within a family are rejected (a copy-paste error in the manifest would otherwise silently collapse under `Set` dedup).
- YAML-null (`deterministic:` with no value) normalizes to "family omitted".

A malformed manifest fails with a path-pointing error (`deterministic[2].copybooks must be an array of strings`), not a deep TypeError from inside the grader.

## Metrics

Per family:

- `expected` / `actual` — set sizes after key canonicalization
- `truePositives` — set intersection
- `falsePositives` — actual − expected (canonical keys, sorted)
- `falseNegatives` — expected − actual
- `precision = TP / (TP + FP)` — 1.0 when no actuals
- `recall = TP / (TP + FN)` — 1.0 when no expectations
- `f1 = 2·P·R / (P + R)` — 0 when both P and R are 0

A **vacuous** family (manifest `[]` + zero emissions) renders with `—`
in metric cells rather than 100% so a dashboard reader can tell it apart
from a family that legitimately scored perfect on real observations.

The `overall` block is a **micro-average** across graded families:
TP, FP, FN are summed across families before computing P/R/F1, so a
high-volume family (lots of deterministic entries) dominates a
low-volume one (a handful of CALL-USING pairs). Skipped families and
vacuous families contribute nothing.

## How to run

```bash
npx vitest run src/cobol/__tests__/field-lineage-eval.test.ts
```

Or in test code:

```ts
import { evaluateFieldLineage, renderEvalReport } from "../field-lineage-eval.js";

const report = evaluateFieldLineage(fixtureDir, {
  // Mirrors the production plugin call site — pass site-specific
  // system callees here when the fixture references them.
  // extraSystemCallees: ["MQCONN", "MQDISC"],
});
expect(report.overall.precision).toBeCloseTo(1, 10);
console.log(renderEvalReport(report));   // markdown table + FP/FN lists
```

The harness is a pure module — it reads from `fixtureDir` and returns the
report. No CLI wrapper yet; vitest is the runner.

## Adding a fixture

1. Create `src/cobol/__tests__/fixtures/eval/<name>/` with one or more
   `.cbl` / `.cpy` files at the top level (subdirectories are ignored).
2. Write `lineage.expected.yaml` listing every entry you expect the
   builder to emit for the families you want graded. Omit families you
   don't want to grade; declare `[]` for families that should emit
   nothing.
3. Add a test case that calls `evaluateFieldLineage(fixtureDir)` and
   asserts the precision / recall thresholds you require — `1.0 / 1.0`
   for ground-truthed fixtures, or a corpus-baseline floor for messier
   real-world corpora. Use `.toBeCloseTo(1, 10)` rather than `.toBe(1)`
   so float accumulation in the F1 formula doesn't make the assertion
   brittle on future non-perfect fixtures.

When a tier's gates are changed (e.g. the Phase C precision gate at
`field-lineage.ts:773`, or the inferred-semantic five-gate at the
matcher), rerun every fixture under `eval/` and confirm metrics move
in the intended direction before landing the change.

## Known limitations

- **The production combiner (`combineFieldLineage`) is bypassed.** The
  harness inspects each builder's raw output directly. If a future
  change adds cross-family filtering at combine time, the harness's
  metrics will diverge from what `wiki/cobol/field-lineage.md`
  regeneration produces.
- **Fixture source discovery is non-recursive.** Only flat `.cbl` /
  `.cpy` files at the fixture-dir top level are picked up.
  Subdirectory layouts (`programs/`, `copybooks/`) are silently
  ignored; reorganize as flat or extend the harness if a fixture
  outgrows it.
- **Field-lineage diagnostics are not surfaced in the report.** If a
  source file fails to parse cleanly (zero data items, copybook
  truncation, etc.), the affected family lights up as FN with no hint
  that the upstream parse was the cause. Re-run the affected file
  through `code_parse` to inspect diagnostics.

## Corpus-level baseline

In addition to the per-fixture manifests, a baseline regression test
(`src/cobol/__tests__/dogfood-ccvs.test.ts`) runs `buildFieldLineage`
across a committed slice of the NIST CCVS COBOL85 test corpus
(`src/cobol/__tests__/corpora/ccvs-replacing-subset/`) and asserts the
full inferred-* emission set matches a committed baseline. This
catches a class of regression the per-fixture tests can't: "the
builder started emitting (or stopped emitting) something the
manifests don't pin."

When you intentionally change candidate-sourcing or matching logic,
regenerate the baseline:

```bash
npx tsx scripts/dogfood-lineage.ts \
  src/cobol/__tests__/corpora/ccvs-replacing-subset \
  src/cobol/__tests__/corpora/ccvs-replacing-subset/baseline-inferred-high.txt
```

Review the diff before committing — every line change is a behavior
change in the builder.

## Fixture inventory

- `eval/basic/` — deterministic copybook reuse + inferred-high cross-
  copybook + CALL-USING positional pair. The widest-coverage fixture;
  exercises three families.
- `eval/db2-column-pairs/` — DB2 cross-program flow with column-level
  binding. INSERT INTO T (cols) VALUES (:hv) on the writer + SELECT
  cols INTO :hv FROM T on the reader. Anchors the `:writer-hv → COL
  → :reader-hv` pairing emitted by `db2-table-lineage.ts:159`. All
  other families declared `[]` to confirm the harness doesn't emit
  anything spurious for them.
- `eval/replacing/` — `deterministic-via-replacing` cohort (#39
  Phase B). Two consumers share a COPY ... REPLACING clause; the
  manifest pins the post-substitution field names. Anchors against
  a Phase B regression that drops the rename.
- `eval/replacing-inferred/` — Phase C (REPLACING-aware inferred).
  Two unrelated copybooks consumed only via REPLACING; the matcher
  widens candidate sourcing to include those cohorts but uses the
  ORIGINAL (pre-substitution) field as matching evidence — projection
  is only used to gate out leaves the cohort would have renamed (their
  name has no source-text backing). The fixture verifies both halves:
  COMMON-ID / COMMON-NAME emit as cross-copybook inferred-high pairs
  on their pre-substitution names (recall gain over pre-Phase-C);
  ENTITY-PK (would be laundered from USER-PK + SKU into the same
  target name) is filtered out by the precision gate.

A `inferredSemantic` fixture is not yet included — the shape-keyed
matcher has five conjoined gates (PIC match, USAGE match, level
match, exact parent path, ≥2 sibling overlap) that interact in
subtle ways. Building a minimal fixture that exercises ONLY semantic
without bleeding into the inferred-high tier requires more care than
the others, and is deferred until there's a concrete tier change
that needs it as a regression anchor.

## Future

- A CLI surface (`agent-wiki eval lineage <dir>`) once there are enough
  fixtures to make running the suite outside vitest worthwhile.
- A baseline-comparison mode that diffs current metrics against a
  committed `baseline.json` and fails if precision regresses — once we
  have stable enough corpora to baseline.
- A `inferredSemantic` fixture (see note above).
- Confidence-tier grading on `callBound` (`deterministic` vs `high`) —
  same shape as deterministic-family linkage pinning; deferred until a
  fixture needs the discrimination.
