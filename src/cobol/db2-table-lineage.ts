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

export interface SerializedDb2LineageEntry {
  confidence: Db2LineageConfidence;
  table: string;
  writer: Db2LineageParticipant;
  reader: Db2LineageParticipant;
  /** Domain-specific evidence detail (table name, ops on each side). */
  evidence: Db2LineageEvidence;
  /** Language-agnostic envelope; consumers branch on `confidence` / `abstain`. */
  envelope: EvidenceEnvelope;
  rationale: string;
}

export interface Db2Lineage {
  summary: {
    sharedTables: number;
    pairs: number;
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
}

/**
 * Resolve a SQL host var name against a program's full data surface, in
 * precedence order:
 *   1. WORKING-STORAGE inline declarations
 *   2. LINKAGE SECTION (callee subprograms receive host vars via CALL USING)
 *   3. Any copybook the program COPYs (the parser does NOT inline-expand
 *      COPY, so copybook fields aren't in `program.dataItems` even though
 *      they're visible to SQL)
 *
 * Inline (#1) takes precedence over a copybook field of the same name —
 * the program's own declaration shadows what's COPY'd in. Returns the
 * matching data item plus, when found via #3, the canonical (uppercased)
 * copybook name as the lexer captured it. COPY REPLACING-aware lookup is
 * not yet implemented: a renamed field still surfaces as unresolved.
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
  return undefined;
}

function toHostVarRef(name: string, resolved: ResolvedHostVar | undefined): HostVarRef {
  if (!resolved) return { name };
  const { dataItem, originCopybook } = resolved;
  return {
    name,
    dataItem: {
      name: dataItem.name,
      level: dataItem.level,
      picture: dataItem.picture,
      usage: dataItem.usage,
      originCopybook,
    },
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
    // Keep the first resolved entry — don't let a later unresolved hit
    // (e.g., from a different SQL block in the same program) clobber
    // useful structural info we already collected.
    if (!existing || (!existing.dataItem && hv.dataItem)) {
      usage.hostVars.set(hv.name, hv);
    }
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
      const hostVars: HostVarRef[] = hostVarNames.map((name) => {
        const resolved = resolveHostVar(program, name, copybooksByLogicalName);
        if (!resolved) {
          const dedupeKey = `${programId}|${name}`;
          if (!seenUnresolved.has(dedupeKey)) {
            seenUnresolved.add(dedupeKey);
            // Only mention REPLACING when the program actually uses COPY at
            // all — otherwise the note is misleading noise on programs that
            // typo'd a pure-inline-WS field. We can't yet detect REPLACING
            // specifically (parser doesn't surface it through `c.replacing`,
            // see follow-up issue), so this is a conservative best-effort.
            const replacingClause = program.copies.length > 0
              ? ` \`COPY ... REPLACING\` renames are not yet applied during `
                + `resolution and may also surface here.`
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
        return toHostVarRef(name, resolved);
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
    summary: { sharedTables, pairs: entries.length, diagnosticsByKind },
    entries,
    diagnostics,
  };
}
