/**
 * Cross-program field lineage via shared DB2 tables.
 *
 * MVP scope (#67, narrowed after corpus dogfood):
 *   - Table-level only — pair (writer program, reader program) for each table
 *     that has both writers and readers in the corpus.
 *   - Operations classified as writes (INSERT/UPDATE/DELETE/MERGE) and reads
 *     (SELECT/FETCH). Other ops (DECLARE/OPEN/CLOSE/WITH) excluded.
 *   - Self-loops (same program is both writer and reader) excluded — those are
 *     intra-program flow, not cross-file.
 *   - Column-level positional mapping is deferred (would need SQL column-list
 *     parsing).
 */

import type { CobolCodeModel } from "./extractors.js";
import type { DataItemNode, SourceLocation } from "./types.js";
import { resolveCanonicalId, displayLabel, normalizeCopybookName } from "./graph.js";
import { cobolTierToEvidence } from "./evidence-mapping.js";
import type { EvidenceEnvelope } from "../evidence.js";

export type Db2LineageConfidence = "deterministic";

/**
 * Reasons a DB2 reference or table was excluded from `entries`. See
 * `buildDb2TableLineage` for where each kind is emitted.
 */
export type Db2LineageDiagnosticKind =
  | "self-loop"             // same program is both writer and reader of the table
  | "non-classifiable-op"   // operation not in WRITE_OPS or READ_OPS (DECLARE/OPEN/CLOSE/WITH)
  | "writer-only"           // table has writers but no readers in the corpus
  | "reader-only"           // table has readers but no writers in the corpus
  | "host-var-unresolved";  // SQL :HOSTVAR not declared in WORKING-STORAGE / LINKAGE

export interface Db2LineageDiagnostic {
  kind: Db2LineageDiagnosticKind;
  /** Program that owns the reference (set for non-classifiable-op, self-loop, host-var-unresolved). */
  programId?: string;
  /** Table involved (set for self-loop, writer-only, reader-only). */
  table?: string;
  /** SQL operation verb (set for non-classifiable-op). */
  operation?: string;
  /** Host variable name without the leading colon (set for host-var-unresolved). */
  hostVar?: string;
  callSite?: SourceLocation;
  rationale: string;
}

/**
 * Resolved in-program definition of a SQL host variable. Carries enough
 * shape to render the host var with its PIC inline so a wiki reader can
 * eyeball type alignment with the SQL column, plus `originCopybook` (when
 * the field was found via a `COPY <book>` rather than declared inline)
 * so the wiki can attribute the field to its source copybook.
 */
export interface HostVarDataItemRef {
  /** Field name as declared (uppercased to match COBOL). */
  name: string;
  /** Level number (01, 05, ...). */
  level: number;
  picture?: string;
  usage?: string;
  /**
   * Name of the copybook the field came from, as recorded by the parser
   * from the program's `COPY <name>` directive. Unquoted forms (`COPY
   * CUSTID`) are uppercased by the lexer at tokenize time and arrive
   * canonical; quoted forms (`COPY 'custid'`) preserve source case
   * because LITERAL tokens aren't canonicalized. The map lookup is
   * case-insensitive either way (via `normalizeCopybookName`), so
   * resolution works correctly — but the rendered string in the wiki
   * follows whatever the source recorded. Absent when the field was
   * declared inline in WORKING-STORAGE or LINKAGE — i.e., absence ≠
   * unresolved, absence = "this field doesn't trace back to a copybook".
   */
  originCopybook?: string;
  /**
   * Present when the field was reached only after applying a
   * `COPY ... REPLACING` substitution (#37 Phase A): the SQL block
   * referenced `toName`, but no data item by that name existed; we
   * matched `toName` against a `BY` target in the program's REPLACING
   * pair list, looked up `fromName` in the copybook, and that succeeded.
   * Lets the renderer surface the rename trail so a reviewer can see
   * why a host var maps to an unexpected field name.
   */
  replacingSubstitution?: { fromName: string; toName: string };
}

/**
 * A SQL host variable reference, possibly resolved to its in-program
 * data item declaration. `dataItem` is undefined when the name in the
 * SQL block doesn't match any item in the program's data tree — those
 * cases also surface as `host-var-unresolved` diagnostics.
 */
export interface HostVarRef {
  /** Name as it appeared in the SQL block (without the leading `:`). */
  name: string;
  /** In-program declaration; undefined if lookup failed. */
  dataItem?: HostVarDataItemRef;
  /**
   * Canonical column-binding list (#41 Phase B). The full set of SQL
   * columns this host var binds to, across every SQL ref in the
   * program. Empty when the SQL shape carried no parseable column
   * info (INSERT without column list, FETCH, etc.).
   *
   * Multi-binding is uncommon-but-real: `INSERT INTO T (ID, ALT_ID)
   * VALUES (:WR-ID, :WR-ID)` binds `:WR-ID` to both `ID` and `ALT_ID`,
   * and a later SELECT reading `ALT_ID INTO :RD-ALT-ID` should still
   * pair the WR-ID write through `ALT_ID`. Storing only the first
   * column (the pre-Phase-B shape) silently dropped that flow.
   * Sorted ascending for byte-stable artifact output.
   */
  columns: string[];
  /**
   * Convenience alias for `columns[0]` — preserved as the public
   * single-binding handle from #41 Phase A so external consumers
   * reading `column` keep working. Absent when `columns` is empty.
   */
  column?: string;
}

const DB2_WRITE_OPS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);
const DB2_READ_OPS = new Set(["SELECT", "FETCH"]);

type AccessKind = "write" | "read";

export interface Db2LineageParticipant {
  programId: string;
  sourceFile: string;
  operations: string[];
  /**
   * SQL host variables referenced on this side of the join, deduped by
   * name and sorted alphabetically. Each entry carries an optional
   * `dataItem` resolved against the program's data tree — present when
   * the name matches a declaration, absent (with a paired
   * `host-var-unresolved` diagnostic) when the lookup fails.
   */
  hostVars: HostVarRef[];
  callSites: SourceLocation[];
}

export interface Db2LineageEvidence {
  sharedTable: string;
  writerOps: string[];
  readerOps: string[];
}

/**
 * Cross-program column-level pairing (#41 Phase B). When both the writer
 * and the reader carry a column binding (from Phase A) for the *same*
 * SQL column, this triple asserts that the value flows
 * `writerHostVar → column → readerHostVar` across the program pair.
 *
 * Asymmetric host-var directionality is implicit in the operations on
 * each side: the writer's `column = :HV` in INSERT/UPDATE writes the
 * host var into the column; the reader's `column INTO :HV` in
 * SELECT/FETCH reads the column into the host var. The structural
 * intersection of the two `column` fields proves the through-flow
 * without needing a SQL parser to argue about it.
 */
export interface Db2ColumnPair {
  column: string;
  writerHostVar: string;
  readerHostVar: string;
}

export interface SerializedDb2LineageEntry {
  confidence: Db2LineageConfidence;
  table: string;
  writer: Db2LineageParticipant;
  reader: Db2LineageParticipant;
  /** Domain-specific evidence detail (table name, ops on each side). */
  evidence: Db2LineageEvidence;
  /** Language-agnostic envelope; consumers branch on `confidence` / `abstain`. */
  envelope: EvidenceEnvelope;
  /**
   * Cross-program column-level pairings (#41 Phase B). Computed by
   * intersecting writer and reader host vars on their `column` field
   * (both sides have to carry a Phase-A column binding for a pair to
   * emit). Empty when one or both sides have no column bindings —
   * common for INSERT-without-column-list, cursor-based FETCH, and any
   * SQL the Phase A regexes can't structure.
   */
  columnPairs: Db2ColumnPair[];
  rationale: string;
}

export interface Db2Lineage {
  summary: {
    sharedTables: number;
    pairs: number;
    /**
     * Total cross-program column pairings across all entries (#41 Phase B).
     * Sum of `entries[i].columnPairs.length`. Surfaced separately so the
     * Coverage block / evidence dashboard can show write-read column depth
     * without walking entries.
     */
    columnPairs: number;
    diagnosticsByKind: Record<Db2LineageDiagnosticKind, number>;
  };
  entries: SerializedDb2LineageEntry[];
  diagnostics: Db2LineageDiagnostic[];
}

const HOST_VAR_RE = /:\s*([A-Z][A-Z0-9-]*)/g;

function extractHostVars(rawText: string): string[] {
  const upper = rawText.toUpperCase();
  return [...new Set([...upper.matchAll(HOST_VAR_RE)].map((m) => m[1]))];
}

/**
 * Parse host-var ↔ column bindings out of a SQL block's raw text (#41
 * Phase A). Three patterns are recognized:
 *
 *   - `INSERT INTO T (col1, col2) VALUES (:h1, :h2)` — column list and
 *     VALUES list paired by position.
 *   - `SELECT col1, col2 INTO :h1, :h2 FROM ...` — SELECT column list and
 *     INTO host-var list paired by position.
 *   - `UPDATE T SET col1 = :h1, col2 = :h2 WHERE ...` — each `col = :host`
 *     pair read explicitly; WHERE-clause host vars are filter predicates
 *     and intentionally not bound.
 *
 * Returns an empty array when the pattern doesn't match cleanly: INSERT
 * with no column list, arity mismatch between column count and value
 * count, FETCH (no column list in this statement — lives on the DECLARE
 * CURSOR), subqueries / INSERT…SELECT, functions inside the column list,
 * or anything else outside the three handled shapes. Falling through to
 * empty is intentional — Phase A trades coverage for precision; a wrong
 * binding is worse than a missing one.
 */
export function parseSqlColumnBindings(
  rawText: string,
  operation: string | undefined,
): Array<{ column: string; hostVar: string }> {
  if (!operation) return [];
  const op = operation.toUpperCase();
  const upper = rawText.toUpperCase();

  if (op === "INSERT") {
    // Require both `(col-list)` and `VALUES (val-list)` to be present.
    // INSERT…SELECT (no VALUES) and INSERT without column list both miss
    // this regex and fall through to an empty result.
    const m = upper.match(/INSERT\s+INTO\s+[A-Z0-9_.-]+\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/);
    if (!m) return [];
    return pairPositional(splitTopLevelCommas(m[1]!), splitTopLevelCommas(m[2]!));
  }

  if (op === "SELECT") {
    // SELECT col-list INTO host-list FROM... The INTO clause anchors both
    // ends — without it (e.g., SELECT cols FROM... in a subquery) there's
    // no host-var list to bind, so we return empty.
    const m = upper.match(/SELECT\s+([\s\S]+?)\s+INTO\s+([\s\S]+?)\s+FROM\b/);
    if (!m) return [];
    return pairPositional(splitTopLevelCommas(m[1]!), splitTopLevelCommas(m[2]!));
  }

  if (op === "UPDATE") {
    // Extract everything between SET and the first terminator: WHERE
    // (predicate — its `:host` is a filter, not a binding), END-EXEC
    // (rawText carries the END-EXEC token; without an anchor on it the
    // last SET assignment would include `END-EXEC` and fail the strict
    // `col = :host` regex below), or end of string.
    const m = upper.match(/SET\s+([\s\S]+?)(?:\s+WHERE\b|\s+END-EXEC\b|\s*$)/);
    if (!m) return [];
    const bindings: Array<{ column: string; hostVar: string }> = [];
    for (const assignment of splitTopLevelCommas(m[1]!)) {
      // Strict `column = :host` shape only. Anything else (arithmetic,
      // function, literal, NULL) drops — we won't pretend we know what
      // gets written.
      const eq = assignment.match(/^([A-Z][A-Z0-9_]*)\s*=\s*:\s*([A-Z][A-Z0-9-]*)\s*$/);
      if (eq) bindings.push({ column: eq[1]!, hostVar: eq[2]! });
    }
    return bindings;
  }

  return [];
}

/**
 * Split on commas at depth-0 paren nesting. Lets `SELECT FUNC(A, B), C`
 * keep `FUNC(A, B)` as a single element instead of shattering on the
 * inner comma. Phase A doesn't need to *understand* the function call;
 * it just needs to not mis-pair it with the host-var list.
 */
function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
}

/**
 * Pair a column list with a value list positionally. The value must be a
 * bare host-var reference (`:NAME`) — anything else (literal, NULL,
 * default, function) drops that position entirely without aborting the
 * whole pairing. Column names that aren't plain identifiers (qualified
 * `schema.col`, quoted, with parens) also drop. Arity mismatch
 * (`cols.length !== vals.length`) aborts the entire pairing — we'd rather
 * miss bindings than emit wrong ones.
 */
function pairPositional(
  cols: string[],
  vals: string[],
): Array<{ column: string; hostVar: string }> {
  if (cols.length !== vals.length) return [];
  const pairs: Array<{ column: string; hostVar: string }> = [];
  for (let i = 0; i < cols.length; i++) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(cols[i]!)) continue;
    const hostMatch = vals[i]!.match(/^:\s*([A-Z][A-Z0-9-]*)$/);
    if (!hostMatch) continue;
    pairs.push({ column: cols[i]!, hostVar: hostMatch[1]! });
  }
  return pairs;
}

/**
 * Recursive name lookup over a list of data item subtrees. SQL host vars
 * can be any data item — top-level (`01 WS-NAME`) or nested (`05 CUST-ID`
 * inside `01 CUSTOMER-RECORD`) — so a flat top-level scan would miss the
 * common case (the field is in a copybook-defined record). Returns the
 * first depth-first match; duplicate names across REDEFINES are rare in
 * host-var usage and not worth disambiguation cost here.
 *
 * `item.name.toUpperCase()` is defensive — the parser already canonicalizes
 * to uppercase, but hand-constructed test fixtures sometimes don't, and
 * the cost is negligible.
 */
function findDataItemByName(items: DataItemNode[], name: string): DataItemNode | undefined {
  const upper = name.toUpperCase();
  for (const item of items) {
    if (item.name.toUpperCase() === upper) return item;
    if (item.children.length > 0) {
      const inner = findDataItemByName(item.children, name);
      if (inner) return inner;
    }
  }
  return undefined;
}

interface ResolvedHostVar {
  dataItem: DataItemNode;
  /** Set when the field was found in a copybook the program COPYs. */
  originCopybook?: string;
  /** Set when the lookup succeeded only via REPLACING fallback (#37 Phase A). */
  replacingSubstitution?: { fromName: string; toName: string };
}

/**
 * Parse the parser's raw `replacing` token array into structured `{ from, to }`
 * substitution pairs (#37 Phase A).
 *
 * The parser records `replacing` as the whitespace-tokenized slice of rawText
 * that follows `REPLACING`. The COBOL lexer treats `=` as a single-character
 * operator, so pseudo-text `==X==` arrives **shattered** as individual `=`
 * tokens around the identifier. Three surface forms this function handles:
 *
 *   - Single-token:    `["X", "BY", "Y"]`                                 → 1 pair
 *   - Pseudo-text:     `["=","=","X","=","=","BY","=","=","Y","=","="]`   → 1 pair
 *   - Multi-pair:      `["X","BY","Y","Z","BY","W"]`                      → 2 pairs
 *
 * Algorithm: drop standalone `=` tokens (the shattered pseudo-text markers),
 * then walk the remainder for `ID BY ID` triplets. Identifier tokens that
 * don't match `[A-Z][A-Z0-9-]*` (fragment substitution, partial-token
 * substring patterns, anything we can't trust as a COBOL identifier) are
 * dropped from the trigger set so they fall through to `host-var-unresolved`.
 */
export function parseReplacingPairs(tokens: readonly string[]): Array<{ from: string; to: string }> {
  const IDENT = /^[A-Z][A-Z0-9-]*$/;
  // Strip the lexer's shattered `=` markers; keep BY and identifier candidates.
  // Also strip pre-shattered `==X==` if it ever arrives as one token (defensive
  // — the COBOL lexer normally shatters, but a different upstream might not).
  const cleaned: string[] = [];
  for (const tok of tokens) {
    if (tok === "=" || tok === "==") continue;
    if (tok.startsWith("==") && tok.endsWith("==") && tok.length >= 4) {
      cleaned.push(tok.slice(2, -2));
    } else {
      cleaned.push(tok);
    }
  }
  const pairs: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] !== "BY") continue;
    const from = cleaned[i - 1];
    const to = cleaned[i + 1];
    if (!from || !to) continue;
    if (!IDENT.test(from) || !IDENT.test(to)) continue;
    pairs.push({ from, to });
  }
  return pairs;
}

/**
 * Resolve a SQL host var name against a program's full data surface, in
 * precedence order:
 *   1. WORKING-STORAGE inline declarations
 *   2. LINKAGE SECTION (callee subprograms receive host vars via CALL USING)
 *   3. Any copybook the program COPYs (the parser does NOT inline-expand
 *      COPY, so copybook fields aren't in `program.dataItems` even though
 *      they're visible to SQL)
 *   4. (#37 Phase A) REPLACING-aware fallback: for each copy carrying a
 *      `REPLACING` pair list, look up `from` in the copybook for any pair
 *      whose `to` equals the requested name. Catches the common case where
 *      the SQL references the substituted name but the copybook still
 *      contains the original.
 *
 * Inline (#1) takes precedence over a copybook field of the same name —
 * the program's own declaration shadows what's COPY'd in. Returns the
 * matching data item plus, when found via #3 or #4, the canonical
 * (uppercased) copybook name as the lexer captured it. Step #4 also
 * attaches `replacingSubstitution` so the renderer can show the rename
 * trail.
 */
function resolveHostVar(
  program: CobolCodeModel,
  name: string,
  copybooksByLogicalName: Map<string, CobolCodeModel[]>,
): ResolvedHostVar | undefined {
  const ws = findDataItemByName(program.dataItems, name);
  if (ws) return { dataItem: ws };
  const lk = findDataItemByName(program.linkageItems, name);
  if (lk) return { dataItem: lk };
  for (const copy of program.copies) {
    const copybooks = copybooksByLogicalName.get(normalizeCopybookName(copy.copybook));
    if (!copybooks) continue;
    for (const cpy of copybooks) {
      const item = findDataItemByName(cpy.dataItems, name);
      if (item) return { dataItem: item, originCopybook: copy.copybook };
    }
  }
  // #37 Phase A — REPLACING-aware fallback. Only entered when every direct
  // lookup above failed; programs without REPLACING never run this loop
  // (`replacing` is undefined and skipped). For each pair whose `to` matches
  // the host-var name we couldn't find, look up `from` in the corresponding
  // copybook. First match wins — the same ordering as the direct path.
  const upperName = name.toUpperCase();
  for (const copy of program.copies) {
    if (!copy.replacing || copy.replacing.length === 0) continue;
    const pairs = parseReplacingPairs(copy.replacing);
    const match = pairs.find((p) => p.to === upperName);
    if (!match) continue;
    const copybooks = copybooksByLogicalName.get(normalizeCopybookName(copy.copybook));
    if (!copybooks) continue;
    for (const cpy of copybooks) {
      const item = findDataItemByName(cpy.dataItems, match.from);
      if (item) {
        return {
          dataItem: item,
          originCopybook: copy.copybook,
          replacingSubstitution: { fromName: match.from, toName: upperName },
        };
      }
    }
  }
  return undefined;
}

function toHostVarRef(
  name: string,
  resolved: ResolvedHostVar | undefined,
  columns: string[],
): HostVarRef {
  // `columns` is sorted for byte-stable artifact output, but `column`
  // (the #41 Phase A back-compat alias) MUST be the first-observed
  // binding to match Phase A's "first column from the SQL" semantics.
  // For `INSERT INTO T (ID, ALT_ID) VALUES (:H, :H)` Phase A read
  // `column === "ID"`; sorting flipped that to `"ALT_ID"` and silently
  // broke external consumers reading the singular handle. Decouple the
  // two: insertion-order [0] for `column`, sorted for `columns`.
  const sortedColumns = [...columns].sort((a, b) => a.localeCompare(b));
  const firstObserved = columns[0];
  const columnFields = columns.length > 0 && firstObserved
    ? { columns: sortedColumns, column: firstObserved }
    : { columns: sortedColumns };
  if (!resolved) return { name, ...columnFields };
  const { dataItem, originCopybook, replacingSubstitution } = resolved;
  return {
    name,
    dataItem: {
      name: dataItem.name,
      level: dataItem.level,
      picture: dataItem.picture,
      usage: dataItem.usage,
      originCopybook,
      ...(replacingSubstitution ? { replacingSubstitution } : {}),
    },
    ...columnFields,
  };
}

function classifyOp(op: string | undefined): AccessKind | null {
  if (!op) return null;
  const upper = op.toUpperCase();
  if (DB2_WRITE_OPS.has(upper)) return "write";
  if (DB2_READ_OPS.has(upper)) return "read";
  return null;
}

function isCopybook(filename: string): boolean {
  return filename.toLowerCase().endsWith(".cpy");
}

interface ProgramTableUsage {
  programId: string;
  sourceFile: string;
  operations: Set<string>;
  /**
   * Map keyed by host-var name so the same name across multiple SQL
   * statements collapses to one entry. The first resolved ref wins (a
   * later unresolved lookup of the same name does not overwrite a
   * previously-resolved entry — this can happen if one SQL block
   * references the field by a misspelled qualifier and another by its
   * real name).
   */
  hostVars: Map<string, HostVarRef>;
  callSites: SourceLocation[];
}

interface TableSides {
  writers: Map<string, ProgramTableUsage>;
  readers: Map<string, ProgramTableUsage>;
}

function bump(
  state: Map<string, TableSides>,
  table: string,
  kind: AccessKind,
  programId: string,
  sourceFile: string,
  op: string,
  hostVars: HostVarRef[],
  loc: SourceLocation,
): void {
  let sides = state.get(table);
  if (!sides) {
    sides = { writers: new Map(), readers: new Map() };
    state.set(table, sides);
  }
  const sideMap = kind === "write" ? sides.writers : sides.readers;
  let usage = sideMap.get(programId);
  if (!usage) {
    usage = {
      programId,
      sourceFile,
      operations: new Set(),
      hostVars: new Map(),
      callSites: [],
    };
    sideMap.set(programId, usage);
  }
  usage.operations.add(op);
  for (const hv of hostVars) {
    const existing = usage.hostVars.get(hv.name);
    if (!existing) {
      usage.hostVars.set(hv.name, hv);
      continue;
    }
    // Field-by-field merge so a later SQL block can fill in info the
    // first one didn't have. `dataItem` keeps first-resolved (refs
    // typically agree); `columns` UNIONS across refs so a host var
    // bound to ID in one SQL and ALT_ID in another carries both
    // (#41 Phase B fix — pre-merge versions only kept the first
    // column, silently dropping later bindings and the Phase B
    // intersection along with them). `column` follows first-observed
    // (existing wins over hv) to preserve the #41 Phase A back-compat
    // alias semantics across cross-ref merges.
    const mergedColumns = [...new Set([...existing.columns, ...hv.columns])]
      .sort((a, b) => a.localeCompare(b));
    const firstObservedColumn = existing.column ?? hv.column;
    const merged: HostVarRef = {
      name: hv.name,
      dataItem: existing.dataItem ?? hv.dataItem,
      columns: mergedColumns,
      ...(firstObservedColumn ? { column: firstObservedColumn } : {}),
    };
    usage.hostVars.set(hv.name, merged);
  }
  usage.callSites.push(loc);
}

function toParticipant(usage: ProgramTableUsage): Db2LineageParticipant {
  return {
    programId: usage.programId,
    sourceFile: usage.sourceFile,
    operations: [...usage.operations].sort(),
    hostVars: [...usage.hostVars.values()].sort((a, b) => a.name.localeCompare(b.name)),
    callSites: usage.callSites,
  };
}

/**
 * Intersect writer and reader host vars on their `column` field to emit
 * cross-program column-level pairings (#41 Phase B). Only host vars that
 * carry a Phase-A `column` binding participate; bare host vars (unbound)
 * never produce a pair.
 *
 * Output is deterministically sorted by column, then writer host var,
 * then reader host var — keeps the artifact byte-stable across rebuilds
 * regardless of the order writer/reader hostVars were merged into the
 * usage map.
 *
 * The Cartesian intersection per column captures the (rare-but-real)
 * case where one side binds the same column from multiple host vars —
 * e.g., an UPDATE that writes the column then re-reads it via a
 * SELECT...INTO in the same program. We emit every legitimate pair so
 * the reviewer sees the full graph; downstream dedup is the consumer's
 * call.
 */
function computeColumnPairs(
  writer: Db2LineageParticipant,
  reader: Db2LineageParticipant,
): Db2ColumnPair[] {
  // Index readers by every column they bind, not just `column` — a single
  // SELECT INTO might land the same host var into multiple columns of a
  // joined result. The Codex review on #43 caught the symmetric writer-
  // side case (`INSERT INTO T (ID, ALT_ID) VALUES (:WR-ID, :WR-ID)`);
  // honoring multi-binding on the reader side too keeps the data model
  // symmetric.
  //
  // Skip host vars whose program-side `dataItem` lookup failed — they're
  // already in the `host-var-unresolved` diagnostic stream and emitting
  // a confident-looking column flow alongside contradicts the signal
  // (Codex review #3 on #43). A reviewer seeing `WS-MISSING → NAME →
  // WS-NAME` would assume the trace is solid; the matching `(?)` in the
  // host-var cell is a weaker contradiction than dropping the pair.
  const readersByColumn = new Map<string, HostVarRef[]>();
  for (const rhv of reader.hostVars) {
    if (!rhv.dataItem) continue;
    for (const col of rhv.columns) {
      const list = readersByColumn.get(col) ?? [];
      list.push(rhv);
      readersByColumn.set(col, list);
    }
  }
  const pairs: Db2ColumnPair[] = [];
  for (const whv of writer.hostVars) {
    if (!whv.dataItem) continue;
    for (const col of whv.columns) {
      const readers = readersByColumn.get(col);
      if (!readers) continue;
      for (const rhv of readers) {
        pairs.push({
          column: col,
          writerHostVar: whv.name,
          readerHostVar: rhv.name,
        });
      }
    }
  }
  return pairs.sort((a, b) =>
    a.column.localeCompare(b.column)
    || a.writerHostVar.localeCompare(b.writerHostVar)
    || a.readerHostVar.localeCompare(b.readerHostVar),
  );
}

export function buildDb2TableLineage(models: CobolCodeModel[]): Db2Lineage | null {
  const programs = models.filter((m) => !isCopybook(m.sourceFile));
  if (programs.length < 2) return null;

  // Index parsed copybooks by their canonical name so host-var resolution
  // can fall back from the program's own data tree to the copybooks it
  // includes via COPY. One canonical name can map to multiple parsed
  // copybook files (same logical name from two directories) — keep all,
  // sorted by sourceFile so the resolver's "first match wins" picks the
  // same one regardless of input order. Without sorting, `originCopybook`
  // would flip across machines depending on filesystem listing order.
  const copybooksByLogicalName = new Map<string, CobolCodeModel[]>();
  for (const model of models) {
    if (!isCopybook(model.sourceFile)) continue;
    const key = normalizeCopybookName(model.sourceFile);
    const list = copybooksByLogicalName.get(key) ?? [];
    list.push(model);
    copybooksByLogicalName.set(key, list);
  }
  for (const list of copybooksByLogicalName.values()) {
    list.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));
  }

  const tableState = new Map<string, TableSides>();
  const diagnostics: Db2LineageDiagnostic[] = [];

  // Track unresolved-host-var diagnostics per (programId, hostVar) so a
  // typo'd field referenced across many SQL blocks doesn't blow up the
  // diagnostic list — the user only needs to be told once per program.
  const seenUnresolved = new Set<string>();

  for (const program of programs) {
    const programId = `program:${resolveCanonicalId(program)}`;
    const sourceFile = program.sourceFile;
    for (const ref of program.db2References) {
      // A DB2 reference with no tables (e.g., DECLARE CURSOR with WHERE-only,
      // or unparseable inline SQL) is silently dropped — neither classifiable
      // nor useful as a diagnostic, since it carries no table identity.
      if (ref.tables.length === 0) continue;

      const op = ref.operation?.toUpperCase();
      const kind = classifyOp(op);
      if (!kind || !op) {
        diagnostics.push({
          kind: "non-classifiable-op",
          programId,
          operation: op ?? "(none)",
          callSite: ref.loc,
          rationale:
            `Operation \`${op ?? "(none)"}\` is not in the writer set `
            + `(INSERT/UPDATE/DELETE/MERGE) or reader set (SELECT/FETCH); `
            + `excluded from cross-program lineage.`,
        });
        continue;
      }
      const hostVarNames = extractHostVars(ref.rawText);
      // #41 Phase A/B — parse column bindings once per SQL ref. Empty when
      // the ref's shape isn't one of the three handled patterns. Multi-
      // binding (one host var bound to multiple columns in the same SQL,
      // e.g. `INSERT INTO T (ID, ALT_ID) VALUES (:WR-ID, :WR-ID)`) is
      // captured as a list per host var — the bump-merge below unions
      // these across all of the program's refs.
      //
      // **Multi-table guard** (Codex review on #43): when the ref touches
      // more than one table (subqueries, JOINs, UPDATE … WHERE EXISTS …),
      // we can't safely attribute a parsed column to one specific table —
      // attaching the same column to every table would let the Phase B
      // intersection emit false pairs (e.g., a SELECT FROM T1 picking up
      // T2 via a WHERE EXISTS subquery would also mark host vars as
      // reading T2's column). Skip column binding entirely on those refs;
      // table-scoping the bindings is bigger Phase C work.
      const bindings = ref.tables.length === 1
        ? parseSqlColumnBindings(ref.rawText, op)
        : [];
      const columnsByHostVar = new Map<string, string[]>();
      for (const b of bindings) {
        const list = columnsByHostVar.get(b.hostVar) ?? [];
        if (!list.includes(b.column)) list.push(b.column);
        columnsByHostVar.set(b.hostVar, list);
      }
      const hostVars: HostVarRef[] = hostVarNames.map((name) => {
        const resolved = resolveHostVar(program, name, copybooksByLogicalName);
        if (!resolved) {
          const dedupeKey = `${programId}|${name}`;
          if (!seenUnresolved.has(dedupeKey)) {
            seenUnresolved.add(dedupeKey);
            // Surface REPLACING as a possible cause only when the program
            // uses it AND the resolver couldn't apply its Phase A fallback.
            // After #37 Phase A, single-token and pseudo-text REPLACING
            // pairs ARE applied — what falls through to this diagnostic
            // are shapes Phase A can't structure (fragment substitution
            // like `==:T== BY ==WS==`, or pseudo-text shattered across
            // whitespace by the lexer). Wording reflects the narrower
            // remaining gap so the hint stays useful instead of vestigial.
            const replacingClause = program.copies.some(
              (c) => c.replacing && c.replacing.length > 0,
            )
              ? ` Single-token and pseudo-text \`COPY ... REPLACING\` pairs `
                + `are applied during resolution; partial-token or fragment `
                + `substitutions are not, and may also surface here.`
              : "";
            diagnostics.push({
              kind: "host-var-unresolved",
              programId,
              hostVar: name,
              callSite: ref.loc,
              rationale:
                `Host variable \`:${name}\` referenced in SQL is not declared `
                + `in WORKING-STORAGE / LINKAGE of \`${displayLabel(programId)}\`, `
                + `nor in any copybook the program COPYs. The lineage table will `
                + `show the name with a \`(?)\` flag; check for typos or for a `
                + `copybook that's referenced via COPY but not present in the `
                + `parsed corpus.${replacingClause}`,
            });
          }
        }
        return toHostVarRef(name, resolved, columnsByHostVar.get(name) ?? []);
      });
      for (const table of ref.tables) {
        bump(tableState, table, kind, programId, sourceFile, op, hostVars, ref.loc);
      }
    }
  }

  const entries: SerializedDb2LineageEntry[] = [];
  let sharedTables = 0;

  for (const [table, sides] of tableState.entries()) {
    // Skip tables with only one role represented in the corpus — but surface
    // them as diagnostics so the user knows which tables flow only one way.
    if (sides.writers.size === 0) {
      diagnostics.push({
        kind: "reader-only",
        table,
        rationale:
          `Table \`${table}\` has reader(s) in the corpus but no writer; `
          + `cross-program write→read lineage cannot be established.`,
      });
      continue;
    }
    if (sides.readers.size === 0) {
      diagnostics.push({
        kind: "writer-only",
        table,
        rationale:
          `Table \`${table}\` has writer(s) in the corpus but no reader; `
          + `cross-program write→read lineage cannot be established.`,
      });
      continue;
    }
    sharedTables++;
    for (const writer of sides.writers.values()) {
      for (const reader of sides.readers.values()) {
        if (writer.programId === reader.programId) {
          diagnostics.push({
            kind: "self-loop",
            programId: writer.programId,
            table,
            rationale:
              `Program \`${writer.programId.replace("program:", "")}\` is `
              + `both writer and reader of \`${table}\`; intra-program flow, `
              + `excluded from cross-file lineage.`,
          });
          continue;
        }
        const writerParticipant = toParticipant(writer);
        const readerParticipant = toParticipant(reader);
        const columnPairs = computeColumnPairs(writerParticipant, readerParticipant);
        const rationale =
          `${writerParticipant.programId.replace("program:", "")} writes to ${table} via ${writerParticipant.operations.join(",")}; `
          + `${readerParticipant.programId.replace("program:", "")} reads from ${table} via ${readerParticipant.operations.join(",")}.`;
        const tier = cobolTierToEvidence("deterministic");
        entries.push({
          confidence: "deterministic",
          table,
          writer: writerParticipant,
          reader: readerParticipant,
          evidence: {
            sharedTable: table,
            writerOps: writerParticipant.operations,
            readerOps: readerParticipant.operations,
          },
          envelope: {
            confidence: tier.confidence,
            basis: tier.basis,
            abstain: false,
            rationale: `Shared DB2 table \`${table}\`; writer and reader programs both observed.`,
            provenance: [
              { raw: writerParticipant.sourceFile },
              { raw: readerParticipant.sourceFile },
            ],
          },
          columnPairs,
          rationale,
        });
      }
    }
  }

  if (entries.length === 0 && diagnostics.length === 0) return null;

  entries.sort((a, b) =>
    a.table.localeCompare(b.table)
    || a.writer.programId.localeCompare(b.writer.programId)
    || a.reader.programId.localeCompare(b.reader.programId)
  );

  const diagnosticsByKind: Record<Db2LineageDiagnosticKind, number> = {
    "self-loop": 0,
    "non-classifiable-op": 0,
    "writer-only": 0,
    "reader-only": 0,
    "host-var-unresolved": 0,
  };
  for (const d of diagnostics) diagnosticsByKind[d.kind]++;

  return {
    summary: {
      sharedTables,
      pairs: entries.length,
      columnPairs: entries.reduce((sum, e) => sum + e.columnPairs.length, 0),
      diagnosticsByKind,
    },
    entries,
    diagnostics,
  };
}
