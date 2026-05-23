import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import yaml from "js-yaml";
import { parse } from "./parser.js";
import { extractModel } from "./extractors.js";
import {
  buildFieldLineage,
  type LineageLinkage,
  type SerializedFieldLineage,
  type SerializedFieldLineageEntry,
  type SerializedInferredFieldLineageEntry,
} from "./field-lineage.js";
import {
  buildCallBoundLineage,
  type CallBoundLineage,
  type SerializedCallBoundLineageEntry,
} from "./call-boundary-lineage.js";
import {
  buildDb2TableLineage,
  type Db2ColumnPair,
  type Db2Lineage,
  type SerializedDb2LineageEntry,
} from "./db2-table-lineage.js";

/**
 * Field-lineage eval harness.
 *
 * Runs the COBOL parse → extractModel → build*Lineage pipeline against a
 * fixture directory containing `.cbl` / `.cpy` files plus a
 * `lineage.expected.yaml` manifest. Each family's actual entries are
 * compared against the manifest by canonical key (case-insensitive, order-
 * independent for set-valued fields like `copybooks` / `programs`) and
 * reported as precision / recall / F1.
 *
 * A family key absent from the manifest is **skipped** (not graded). A
 * family declared as `[]` is **graded strictly** — any emitted entry
 * counts as a false positive. This lets a small fixture exercise three
 * families without being punished for not declaring the others.
 *
 * Known limitations (intentional, documented at docs/field-lineage-eval.md):
 *   - The production combiner (`combineFieldLineage`) is bypassed; the
 *     harness inspects each builder's raw output. Any future cross-
 *     family filtering at combine time would diverge from harness
 *     metrics.
 *   - Fixture source discovery is non-recursive — flat `.cbl` / `.cpy`
 *     files only. Subdirectories are ignored.
 */

export type FamilyName =
  | "deterministic"
  | "inferredHigh"
  | "inferredAmbiguous"
  | "inferredSemantic"
  | "callBound"
  | "db2";

const FAMILY_NAMES: ReadonlySet<FamilyName> = new Set<FamilyName>([
  "deterministic",
  "inferredHigh",
  "inferredAmbiguous",
  "inferredSemantic",
  "callBound",
  "db2",
]);

export interface ExpectedDeterministic {
  fieldName: string;
  /** Copybook logical names (no `copybook:` prefix). Order-independent. */
  copybooks: string[];
  /** Program IDs (no `program:` prefix). Order-independent. */
  programs: string[];
  /**
   * Optional linkage tier pin. When set, only an actual entry whose
   * `linkage` field matches this value counts as a true positive — a
   * builder regression that emits the correct field under the wrong
   * tier (e.g. plain `deterministic` instead of
   * `deterministic-via-replacing`, losing the `replacing` evidence)
   * surfaces as FN+FP. Mode is family-wide: either ALL deterministic
   * entries pin linkage, or NONE do.
   */
  linkage?: LineageLinkage;
}

export interface ExpectedInferred {
  fieldName: string;
  /** Exactly two copybook logical names — the pair's left + right. Order-independent. */
  copybooks: [string, string];
  /**
   * Optional qualified-name pin — when set, only an actual pair whose
   * left/right qualifiedNames (case-insensitive, order-independent) match
   * counts as a true positive. Useful when a copybook nests the same
   * leaf under multiple parents.
   */
  qualifiedNames?: [string, string];
}

export interface ExpectedCallBound {
  /** Caller program ID (no `program:` prefix). */
  caller: string;
  /** Callee program ID (no `program:` prefix). */
  callee: string;
  /** 0-indexed positional argument on the CALL site. */
  position: number;
  /**
   * Caller-side field name (leaf, uppercase canonical). Either this OR
   * `callerQualified` must be specified; `callerQualified` is more
   * precise for nested fields.
   */
  callerField?: string;
  /** Callee-side LINKAGE field name (leaf, uppercase canonical). */
  calleeField?: string;
  /** Caller-side qualified path; overrides `callerField` when both set. */
  callerQualified?: string;
  /** Callee-side qualified path; overrides `calleeField` when both set. */
  calleeQualified?: string;
}

export interface ExpectedDb2ColumnPair {
  column: string;
  writerHostVar: string;
  readerHostVar: string;
}

export interface ExpectedDb2Pair {
  table: string;
  /** Writer program ID (no `program:` prefix). */
  writer: string;
  /** Reader program ID (no `program:` prefix). */
  reader: string;
  /**
   * When omitted, column-level pairs are NOT graded for this entry —
   * the actual builder may emit any number of column pairs without
   * affecting precision. When set (even as `[]`), column pairs are
   * graded strictly: any actual column pair not listed is a false
   * positive, any listed pair the builder didn't emit is a false
   * negative.
   */
  columnPairs?: ExpectedDb2ColumnPair[];
}

export interface EvalManifest {
  version: 1;
  description?: string;
  deterministic?: ExpectedDeterministic[];
  inferredHigh?: ExpectedInferred[];
  inferredAmbiguous?: ExpectedInferred[];
  inferredSemantic?: ExpectedInferred[];
  callBound?: ExpectedCallBound[];
  db2?: ExpectedDb2Pair[];
}

export interface FamilyMetrics {
  /** Discriminant: `false` here, `true` on the skipped variant. */
  skipped: false;
  expected: number;
  actual: number;
  truePositives: number;
  /** Canonical keys of entries the builder emitted that the manifest didn't list. */
  falsePositives: string[];
  /** Canonical keys of manifest entries the builder didn't emit. */
  falseNegatives: string[];
  precision: number;
  recall: number;
  f1: number;
}

export interface SkippedFamily {
  skipped: true;
}

export type FamilyResult = FamilyMetrics | SkippedFamily;

export interface EvalReport {
  fixture: string;
  families: Record<FamilyName, FamilyResult>;
  /** Micro-averaged across graded families (skipped families contribute nothing). */
  overall: { precision: number; recall: number; f1: number };
}

export interface EvaluateOptions {
  /**
   * Forwarded to `buildCallBoundLineage` to mirror the production plugin
   * call site (`plugin.ts`). Site-specific runtime libraries the wiki
   * config classifies as system callees won't fire `unresolved-callee`
   * diagnostics or affect call-bound pairing.
   */
  extraSystemCallees?: readonly string[];
}

const FIXTURE_SOURCE_EXTENSIONS = /\.(cbl|cob|cpy)$/i;
const KNOWN_FAMILY_KEYS = new Set<string>([
  "version",
  "description",
  ...FAMILY_NAMES,
]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function validateFamilyArray<T>(
  manifest: Record<string, unknown>,
  family: FamilyName,
  manifestPath: string,
  validateEntry: (entry: unknown, index: number) => T,
): T[] | undefined {
  const raw = manifest[family];
  // Treat both `undefined` and YAML-null as "family omitted".
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(
      `Manifest ${manifestPath}: family '${family}' must be an array (got ${typeof raw}).`,
    );
  }
  return raw.map((entry, index) => {
    try {
      return validateEntry(entry, index);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Manifest ${manifestPath}: ${msg}`);
    }
  });
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`Manifest field ${path} must be a string (got ${typeof value} = ${String(value)}).`);
  }
  if (value.trim() === "") {
    throw new Error(`Manifest field ${path} must be a non-empty string.`);
  }
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!isStringArray(value)) {
    throw new Error(`Manifest field ${path} must be an array of strings.`);
  }
  if (value.some((s) => s.trim() === "")) {
    throw new Error(`Manifest field ${path} must not contain empty strings.`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Manifest field ${path} must be a non-negative integer (got ${String(value)}).`);
  }
  return value;
}

const LINKAGE_VALUES: ReadonlySet<LineageLinkage> = new Set<LineageLinkage>([
  "deterministic",
  "deterministic-via-replacing",
]);

function validateDeterministic(entry: unknown, index: number): ExpectedDeterministic {
  if (!entry || typeof entry !== "object") {
    throw new Error(`deterministic[${index}] must be an object.`);
  }
  const e = entry as Record<string, unknown>;
  const copybooks = requireStringArray(e.copybooks, `deterministic[${index}].copybooks`);
  if (copybooks.length === 0) {
    throw new Error(`deterministic[${index}].copybooks must list at least one copybook.`);
  }
  const programs = requireStringArray(e.programs, `deterministic[${index}].programs`);
  if (programs.length < 2) {
    throw new Error(
      `deterministic[${index}].programs must list at least two programs (deterministic emission requires ≥2 consumers).`,
    );
  }
  const result: ExpectedDeterministic = {
    fieldName: requireString(e.fieldName, `deterministic[${index}].fieldName`),
    copybooks,
    programs,
  };
  if (e.linkage !== undefined) {
    if (typeof e.linkage !== "string" || !LINKAGE_VALUES.has(e.linkage as LineageLinkage)) {
      throw new Error(
        `deterministic[${index}].linkage must be one of ${[...LINKAGE_VALUES].map((v) => `'${v}'`).join(", ")} (got ${String(e.linkage)}).`,
      );
    }
    result.linkage = e.linkage as LineageLinkage;
  }
  return result;
}

function validateInferred(entry: unknown, index: number, family: FamilyName): ExpectedInferred {
  if (!entry || typeof entry !== "object") {
    throw new Error(`${family}[${index}] must be an object.`);
  }
  const e = entry as Record<string, unknown>;
  const copybooks = requireStringArray(e.copybooks, `${family}[${index}].copybooks`);
  if (copybooks.length !== 2) {
    throw new Error(`${family}[${index}].copybooks must list exactly two copybook names (got ${copybooks.length}).`);
  }
  const result: ExpectedInferred = {
    fieldName: requireString(e.fieldName, `${family}[${index}].fieldName`),
    copybooks: [copybooks[0]!, copybooks[1]!],
  };
  if (e.qualifiedNames !== undefined) {
    const qns = requireStringArray(e.qualifiedNames, `${family}[${index}].qualifiedNames`);
    if (qns.length !== 2) {
      throw new Error(`${family}[${index}].qualifiedNames must list exactly two paths (got ${qns.length}).`);
    }
    result.qualifiedNames = [qns[0]!, qns[1]!];
  }
  return result;
}

function validateCallBound(entry: unknown, index: number): ExpectedCallBound {
  if (!entry || typeof entry !== "object") {
    throw new Error(`callBound[${index}] must be an object.`);
  }
  const e = entry as Record<string, unknown>;
  const result: ExpectedCallBound = {
    caller: requireString(e.caller, `callBound[${index}].caller`),
    callee: requireString(e.callee, `callBound[${index}].callee`),
    position: requireNonNegativeInteger(e.position, `callBound[${index}].position`),
  };
  if (e.callerField !== undefined) result.callerField = requireString(e.callerField, `callBound[${index}].callerField`);
  if (e.calleeField !== undefined) result.calleeField = requireString(e.calleeField, `callBound[${index}].calleeField`);
  if (e.callerQualified !== undefined) result.callerQualified = requireString(e.callerQualified, `callBound[${index}].callerQualified`);
  if (e.calleeQualified !== undefined) result.calleeQualified = requireString(e.calleeQualified, `callBound[${index}].calleeQualified`);
  // Reject mixed callerField + callerQualified to make grading deterministic
  // — otherwise the precedence depends on whether any sibling entry in the
  // family pinned qualifiedName, which is surprising and undocumented.
  if (result.callerField !== undefined && result.callerQualified !== undefined) {
    throw new Error(`callBound[${index}] must specify callerField OR callerQualified, not both.`);
  }
  if (result.calleeField !== undefined && result.calleeQualified !== undefined) {
    throw new Error(`callBound[${index}] must specify calleeField OR calleeQualified, not both.`);
  }
  if (result.callerField === undefined && result.callerQualified === undefined) {
    throw new Error(`callBound[${index}] must specify callerField or callerQualified.`);
  }
  if (result.calleeField === undefined && result.calleeQualified === undefined) {
    throw new Error(`callBound[${index}] must specify calleeField or calleeQualified.`);
  }
  // Caller-side and callee-side pinning mode must agree on a single entry —
  // otherwise gradeCallBound's family-level `anyQualified` flag would mix
  // an undefined caller qualified with a defined callee qualified (or vice
  // versa) and crash on `up(undefined)`. Reject the asymmetric form at
  // validation time with a clear pointer.
  const callerPinned = result.callerQualified !== undefined;
  const calleePinned = result.calleeQualified !== undefined;
  if (callerPinned !== calleePinned) {
    throw new Error(
      `callBound[${index}] must use the same pinning mode on both sides — got ${callerPinned ? "callerQualified" : "callerField"} + ${calleePinned ? "calleeQualified" : "calleeField"}.`,
    );
  }
  return result;
}

function validateDb2Pair(entry: unknown, index: number): ExpectedDb2Pair {
  if (!entry || typeof entry !== "object") {
    throw new Error(`db2[${index}] must be an object.`);
  }
  const e = entry as Record<string, unknown>;
  const result: ExpectedDb2Pair = {
    table: requireString(e.table, `db2[${index}].table`),
    writer: requireString(e.writer, `db2[${index}].writer`),
    reader: requireString(e.reader, `db2[${index}].reader`),
  };
  if (e.columnPairs !== undefined) {
    // YAML-null is rejected here (rather than normalized to omitted): the
    // distinction between "column-pair grading off" (omitted) and
    // "column-pair grading on with zero pairs expected" (`[]`) is
    // load-bearing for the schema, so bare `columnPairs:` is ambiguous
    // and must be written explicitly.
    if (e.columnPairs === null) {
      throw new Error(`db2[${index}].columnPairs must be an array (write \`[]\` to grade column-empty strictly, or omit the key entirely to skip column grading).`);
    }
    if (!Array.isArray(e.columnPairs)) {
      throw new Error(`db2[${index}].columnPairs must be an array.`);
    }
    result.columnPairs = e.columnPairs.map((cp, j) => {
      if (!cp || typeof cp !== "object") {
        throw new Error(`db2[${index}].columnPairs[${j}] must be an object.`);
      }
      const c = cp as Record<string, unknown>;
      return {
        column: requireString(c.column, `db2[${index}].columnPairs[${j}].column`),
        writerHostVar: requireString(c.writerHostVar, `db2[${index}].columnPairs[${j}].writerHostVar`),
        readerHostVar: requireString(c.readerHostVar, `db2[${index}].columnPairs[${j}].readerHostVar`),
      };
    });
  }
  return result;
}

export function loadManifest(path: string): EvalManifest {
  // Default js-yaml schema coerces unquoted `true`/`false`/`null`/`~` and
  // numeric-looking strings; we re-check field types below to catch any
  // coercion that slipped through.
  const raw = yaml.load(readFileSync(path, "utf-8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Manifest ${path} did not parse to a YAML mapping.`);
  }
  const manifest = raw as Record<string, unknown>;
  if (manifest.version !== 1) {
    throw new Error(
      `Manifest ${path} has unsupported version ${String(manifest.version)} (expected 1).`,
    );
  }
  for (const key of Object.keys(manifest)) {
    if (!KNOWN_FAMILY_KEYS.has(key)) {
      throw new Error(`Manifest ${path}: unknown top-level key '${key}'. Known keys: ${[...KNOWN_FAMILY_KEYS].sort().join(", ")}.`);
    }
  }
  if (manifest.description !== undefined && typeof manifest.description !== "string") {
    throw new Error(`Manifest ${path}: 'description' must be a string when set.`);
  }
  return {
    version: 1,
    ...(typeof manifest.description === "string" ? { description: manifest.description } : {}),
    deterministic: validateFamilyArray(manifest, "deterministic", path, validateDeterministic),
    inferredHigh: validateFamilyArray(manifest, "inferredHigh", path, (e, i) => validateInferred(e, i, "inferredHigh")),
    inferredAmbiguous: validateFamilyArray(manifest, "inferredAmbiguous", path, (e, i) => validateInferred(e, i, "inferredAmbiguous")),
    inferredSemantic: validateFamilyArray(manifest, "inferredSemantic", path, (e, i) => validateInferred(e, i, "inferredSemantic")),
    callBound: validateFamilyArray(manifest, "callBound", path, validateCallBound),
    db2: validateFamilyArray(manifest, "db2", path, validateDb2Pair),
  };
}

export function evaluateFieldLineage(
  fixtureDir: string,
  options: EvaluateOptions = {},
): EvalReport {
  const manifestPath = join(fixtureDir, "lineage.expected.yaml");
  const manifest = loadManifest(manifestPath);

  const sources = readdirSync(fixtureDir, { withFileTypes: true })
    .filter((dirent) => dirent.isFile() && FIXTURE_SOURCE_EXTENSIONS.test(dirent.name))
    .map((dirent) => dirent.name)
    .sort();
  const models = sources.map((rel) => {
    const src = readFileSync(join(fixtureDir, rel), "utf-8");
    return extractModel(parse(src, rel));
  });

  const copybookLineage = buildFieldLineage(models);
  const callBoundLineage = buildCallBoundLineage(
    models,
    options.extraSystemCallees !== undefined
      ? { extraSystemCallees: options.extraSystemCallees }
      : undefined,
  );
  const db2Lineage = buildDb2TableLineage(models);

  const families: Record<FamilyName, FamilyResult> = {
    deterministic: gradeDeterministic(manifest.deterministic, copybookLineage),
    inferredHigh: gradeInferred(manifest.inferredHigh, "inferredHigh", copybookLineage?.inferredHighConfidence),
    inferredAmbiguous: gradeInferred(manifest.inferredAmbiguous, "inferredAmbiguous", copybookLineage?.inferredAmbiguous),
    inferredSemantic: gradeInferred(manifest.inferredSemantic, "inferredSemantic", copybookLineage?.inferredSemantic),
    callBound: gradeCallBound(manifest.callBound, callBoundLineage),
    db2: gradeDb2(manifest.db2, db2Lineage),
  };

  return {
    fixture: basename(fixtureDir),
    families,
    overall: microAverage(families),
  };
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function up(value: string): string {
  return value.toUpperCase();
}

function sortedUpper(values: Iterable<string>): string[] {
  return [...values].map(up).sort();
}

function deterministicKey(
  fieldName: string,
  copybooks: string[],
  programs: string[],
  linkage?: LineageLinkage,
): string {
  const base = `${up(fieldName)}|cbs=${sortedUpper(copybooks).join(",")}|pgs=${sortedUpper(programs).join(",")}`;
  return linkage === undefined ? base : `${base}|tier=${linkage}`;
}

function gradeDeterministic(
  expected: ExpectedDeterministic[] | undefined,
  actual: SerializedFieldLineage | null,
): FamilyResult {
  if (expected === undefined) return { skipped: true };
  // All-or-nothing tier pinning: a deterministic family is either tier-aware
  // (every entry pins `linkage`) or tier-agnostic (none do). Mixed-pin would
  // require per-entry matching to disambiguate; reject it for the same
  // reason inferred-family mixed qualifiedNames are rejected.
  const pinned = expected.filter((e) => e.linkage !== undefined).length;
  if (pinned !== 0 && pinned !== expected.length) {
    throw new Error(
      `deterministic: either ALL entries must pin linkage, or NONE — got ${pinned} pinned of ${expected.length}. Mixed pinning makes tier-aware grading ambiguous.`,
    );
  }
  const tierAware = pinned > 0;
  const expectedList = expected.map((e) =>
    deterministicKey(e.fieldName, e.copybooks, e.programs, tierAware ? e.linkage : undefined),
  );
  const actualList = (actual?.deterministic ?? []).map((entry: SerializedFieldLineageEntry) =>
    deterministicKey(
      entry.fieldName,
      entry.copybooks.map((cb) => stripPrefix(cb.id, "copybook:")),
      entry.programs.map((p) => stripPrefix(p.id, "program:")),
      tierAware ? entry.linkage : undefined,
    ),
  );
  assertNoDuplicates(expectedList, "deterministic (manifest)");
  return gradeKeyed(expectedList, actualList, "deterministic");
}

function inferredKey(
  fieldName: string,
  participants: ReadonlyArray<{ copybook: string; qualifiedName?: string }>,
): string {
  // Keep (copybook, qualifiedName) tuples together when sorting so that
  // transposing the pair in the manifest can't accidentally match an
  // actual emission with the OPPOSITE cross-pairing.
  const pairs = participants
    .map((p) => ({ cb: up(p.copybook), qn: p.qualifiedName !== undefined ? up(p.qualifiedName) : undefined }))
    .sort((a, b) => (a.cb === b.cb ? (a.qn ?? "").localeCompare(b.qn ?? "") : a.cb.localeCompare(b.cb)));
  const hasQn = pairs.every((p) => p.qn !== undefined);
  const segments = pairs.map((p) => (hasQn ? `${p.cb}:${p.qn}` : p.cb));
  const axis = hasQn ? "pairs" : "cbs";
  return `${up(fieldName)}|${axis}=${segments.join(",")}`;
}

function gradeInferred(
  expected: ExpectedInferred[] | undefined,
  family: FamilyName,
  actualEntries: SerializedInferredFieldLineageEntry[] | undefined,
): FamilyResult {
  if (expected === undefined) return { skipped: true };
  // Mixed-pin is rejected — either ALL entries in the family pin
  // qualifiedNames or NONE do. Otherwise the harness would have to invent
  // a fallback qualifiedName for unpinned entries, which only works for
  // 1-level-deep fields and silently misgrades anything nested.
  const pinned = expected.filter((e) => e.qualifiedNames !== undefined).length;
  if (pinned !== 0 && pinned !== expected.length) {
    throw new Error(
      `${family}: either ALL entries must pin qualifiedNames, or NONE — got ${pinned} pinned of ${expected.length}. Mixed pinning makes nested-field grading ambiguous.`,
    );
  }
  const anyQualified = pinned > 0;
  const expectedList = expected.map((e) =>
    inferredKey(
      e.fieldName,
      e.copybooks.map((cb, i) => ({
        copybook: cb,
        qualifiedName: anyQualified ? e.qualifiedNames![i] : undefined,
      })),
    ),
  );
  const actualList = (actualEntries ?? []).map((e) =>
    inferredKey(e.fieldName, [
      {
        copybook: stripPrefix(e.left.copybook.id, "copybook:"),
        qualifiedName: anyQualified ? e.left.qualifiedName : undefined,
      },
      {
        copybook: stripPrefix(e.right.copybook.id, "copybook:"),
        qualifiedName: anyQualified ? e.right.qualifiedName : undefined,
      },
    ]),
  );
  assertNoDuplicates(expectedList, `${family} (manifest)`);
  return gradeKeyed(expectedList, actualList, family);
}

function callBoundKey(
  caller: string,
  callee: string,
  position: number,
  callerName: string,
  calleeName: string,
): string {
  return [up(caller), up(callee), position, up(callerName), up(calleeName)].join("|");
}

function gradeCallBound(
  expected: ExpectedCallBound[] | undefined,
  actual: CallBoundLineage | null,
): FamilyResult {
  if (expected === undefined) return { skipped: true };
  // All-or-nothing pinning: a family is either qualified-mode (every
  // entry uses callerQualified+calleeQualified) or leaf-mode (every
  // entry uses callerField+calleeField). Mixed-pin is rejected by
  // validateCallBound for per-entry consistency; here we also reject
  // cross-entry inconsistency so grading is unambiguous.
  const qualifiedEntries = expected.filter(
    (e) => e.callerQualified !== undefined || e.calleeQualified !== undefined,
  ).length;
  if (qualifiedEntries !== 0 && qualifiedEntries !== expected.length) {
    throw new Error(
      `callBound: either ALL entries must pin qualifiedNames, or NONE — got ${qualifiedEntries} pinned of ${expected.length}.`,
    );
  }
  const anyQualified = qualifiedEntries > 0;
  const expectedList = expected.map((e) => {
    const callerName = anyQualified ? e.callerQualified! : e.callerField!;
    const calleeName = anyQualified ? e.calleeQualified! : e.calleeField!;
    return callBoundKey(e.caller, e.callee, e.position, callerName, calleeName);
  });
  const actualList = (actual?.entries ?? []).map((e: SerializedCallBoundLineageEntry) =>
    callBoundKey(
      stripPrefix(e.caller.programId, "program:"),
      stripPrefix(e.callee.programId, "program:"),
      e.position,
      anyQualified ? e.caller.qualifiedName : e.caller.fieldName,
      anyQualified ? e.callee.qualifiedName : e.callee.fieldName,
    ),
  );
  assertNoDuplicates(expectedList, "callBound (manifest)");
  return gradeKeyed(expectedList, actualList, "callBound");
}

function db2PairKey(table: string, writer: string, reader: string): string {
  return `pair:${up(table)}|w=${up(writer)}|r=${up(reader)}`;
}
function db2ColumnKey(
  table: string,
  writer: string,
  reader: string,
  cp: ExpectedDb2ColumnPair | Db2ColumnPair,
): string {
  return `col:${up(table)}|w=${up(writer)}|r=${up(reader)}|${up(cp.column)}|wh=${up(cp.writerHostVar)}|rh=${up(cp.readerHostVar)}`;
}

function gradeDb2(
  expected: ExpectedDb2Pair[] | undefined,
  actual: Db2Lineage | null,
): FamilyResult {
  if (expected === undefined) return { skipped: true };
  // Per-pair column-grading opt-in: only entries whose manifest carries
  // `columnPairs` (even `[]`) participate in column-level grading; for
  // entries without the field, the actual builder's column pairs are
  // ignored — pair-level recall stands on its own.
  const expectedKeysForPair = new Map<string, string[]>();
  const expectedPairKeys: string[] = [];
  for (const [i, e] of expected.entries()) {
    const pk = db2PairKey(e.table, e.writer, e.reader);
    expectedPairKeys.push(pk);
    if (e.columnPairs !== undefined) {
      const cols = e.columnPairs.map((cp) => db2ColumnKey(e.table, e.writer, e.reader, cp));
      assertNoDuplicates(cols, `db2[${i}].columnPairs (manifest)`);
      expectedKeysForPair.set(pk, cols);
    }
  }
  assertNoDuplicates(expectedPairKeys, "db2 pairs (manifest)");

  const expectedList: string[] = [...expectedPairKeys];
  for (const cols of expectedKeysForPair.values()) {
    expectedList.push(...cols);
  }

  const actualList: string[] = [];
  for (const e of actual?.entries ?? []) {
    const writer = stripPrefix(e.writer.programId, "program:");
    const reader = stripPrefix(e.reader.programId, "program:");
    const pk = db2PairKey(e.table, writer, reader);
    actualList.push(pk);
    // Grade column pairs only if the matching manifest entry opted in.
    if (expectedKeysForPair.has(pk)) {
      for (const cp of e.columnPairs) {
        actualList.push(db2ColumnKey(e.table, writer, reader, cp));
      }
    }
  }
  return gradeKeyed(expectedList, actualList, "db2");
}

function assertNoDuplicates(list: string[], context: string): void {
  if (list.length === new Set(list).size) return;
  const counts = new Map<string, number>();
  for (const k of list) counts.set(k, (counts.get(k) ?? 0) + 1);
  const dups = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k).sort();
  throw new Error(
    `Duplicate ${context} entries (canonical key collision): ${dups.map((d) => `'${d}'`).join(", ")}.`,
  );
}

/**
 * Surfaces actual-side duplicate canonical keys as an explicit error.
 * Without this, two structurally distinct emissions that share a canonical
 * key would collapse into one set element and a builder regression
 * (e.g. double-emission of the same lineage row) would score 100%.
 */
function gradeKeyed(expectedList: string[], actualList: string[], family?: string): FamilyMetrics {
  if (family !== undefined) {
    assertNoDuplicates(actualList, `${family} (actual)`);
  }
  const expected = new Set(expectedList);
  const actual = new Set(actualList);
  const truePositives: string[] = [];
  const falsePositives: string[] = [];
  const falseNegatives: string[] = [];
  for (const key of actual) {
    if (expected.has(key)) truePositives.push(key);
    else falsePositives.push(key);
  }
  for (const key of expected) {
    if (!actual.has(key)) falseNegatives.push(key);
  }
  const tp = truePositives.length;
  const fp = falsePositives.length;
  const fn = falseNegatives.length;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  return {
    skipped: false,
    expected: expected.size,
    actual: actual.size,
    truePositives: tp,
    falsePositives: falsePositives.sort(),
    falseNegatives: falseNegatives.sort(),
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
}

function isMetrics(fam: FamilyResult): fam is FamilyMetrics {
  return fam.skipped === false;
}

function microAverage(
  families: Record<FamilyName, FamilyResult>,
): { precision: number; recall: number; f1: number } {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const fam of Object.values(families)) {
    if (!isMetrics(fam)) continue;
    tp += fam.truePositives;
    fp += fam.actual - fam.truePositives;
    fn += fam.expected - fam.truePositives;
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

const FAMILY_LABELS: Record<FamilyName, string> = {
  deterministic: "Deterministic shared copybook",
  inferredHigh: "Inferred — high confidence",
  inferredAmbiguous: "Inferred — ambiguous",
  inferredSemantic: "Inferred — semantic (renamed shape)",
  callBound: "CALL ... USING boundary",
  db2: "DB2 cross-program flow",
};

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderEvalReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# Field-lineage eval — \`${report.fixture}\``);
  lines.push("");
  lines.push(
    `**Overall (micro-averaged across graded families):** precision ${fmtPct(report.overall.precision)}, recall ${fmtPct(report.overall.recall)}, F1 ${fmtPct(report.overall.f1)}.`,
  );
  lines.push("");
  lines.push("| Family | Expected | Actual | TP | FP | FN | Precision | Recall | F1 |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const name of Object.keys(report.families) as FamilyName[]) {
    const fam = report.families[name];
    const label = FAMILY_LABELS[name];
    if (!isMetrics(fam)) {
      lines.push(`| ${label} | _skipped_ | — | — | — | — | — | — | — |`);
      continue;
    }
    // Vacuous family (manifest `[]` + zero emissions) — surface as `—`
    // rather than 100% so a dashboard reader can tell it apart from a
    // family that legitimately scored perfect on real observations.
    const isVacuous = fam.expected === 0 && fam.actual === 0;
    const metric = (value: number): string => (isVacuous ? "—" : fmtPct(value));
    lines.push(
      `| ${label} | ${fam.expected} | ${fam.actual} | ${fam.truePositives} | ${fam.actual - fam.truePositives} | ${fam.expected - fam.truePositives} | ${metric(fam.precision)} | ${metric(fam.recall)} | ${metric(fam.f1)} |`,
    );
  }

  for (const name of Object.keys(report.families) as FamilyName[]) {
    const fam = report.families[name];
    if (!isMetrics(fam)) continue;
    if (fam.falsePositives.length === 0 && fam.falseNegatives.length === 0) continue;
    lines.push("");
    lines.push(`### ${FAMILY_LABELS[name]}`);
    if (fam.falsePositives.length > 0) {
      lines.push("");
      lines.push("**False positives** (emitted but not expected):");
      for (const key of fam.falsePositives) lines.push(`- \`${key}\``);
    }
    if (fam.falseNegatives.length > 0) {
      lines.push("");
      lines.push("**False negatives** (expected but not emitted):");
      for (const key of fam.falseNegatives) lines.push(`- \`${key}\``);
    }
  }
  return lines.join("\n") + "\n";
}
