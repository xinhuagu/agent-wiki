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
import type { SourceLocation } from "./types.js";
import { resolveCanonicalId } from "./graph.js";
import { cobolTierToEvidence } from "./evidence-mapping.js";
import type { EvidenceEnvelope } from "../evidence.js";

export type Db2LineageConfidence = "deterministic";

/**
 * Reasons a DB2 reference or table was excluded from `entries`. See
 * `buildDb2TableLineage` for where each kind is emitted.
 */
export type Db2LineageDiagnosticKind =
  | "self-loop"           // same program is both writer and reader of the table
  | "non-classifiable-op" // operation not in WRITE_OPS or READ_OPS (DECLARE/OPEN/CLOSE/WITH)
  | "writer-only"         // table has writers but no readers in the corpus
  | "reader-only";        // table has readers but no writers in the corpus

export interface Db2LineageDiagnostic {
  kind: Db2LineageDiagnosticKind;
  /** Program that owns the reference (set for non-classifiable-op and self-loop). */
  programId?: string;
  /** Table involved (set for self-loop, writer-only, reader-only). */
  table?: string;
  /** SQL operation verb (set for non-classifiable-op). */
  operation?: string;
  callSite?: SourceLocation;
  rationale: string;
}

const DB2_WRITE_OPS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);
const DB2_READ_OPS = new Set(["SELECT", "FETCH"]);

type AccessKind = "write" | "read";

export interface Db2LineageParticipant {
  programId: string;
  sourceFile: string;
  operations: string[];
  hostVars: string[];
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
  hostVars: Set<string>;
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
  hostVars: string[],
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
      hostVars: new Set(),
      callSites: [],
    };
    sideMap.set(programId, usage);
  }
  usage.operations.add(op);
  for (const hv of hostVars) usage.hostVars.add(hv);
  usage.callSites.push(loc);
}

function toParticipant(usage: ProgramTableUsage): Db2LineageParticipant {
  return {
    programId: usage.programId,
    sourceFile: usage.sourceFile,
    operations: [...usage.operations].sort(),
    hostVars: [...usage.hostVars].sort(),
    callSites: usage.callSites,
  };
}

export function buildDb2TableLineage(models: CobolCodeModel[]): Db2Lineage | null {
  const programs = models.filter((m) => !isCopybook(m.sourceFile));
  if (programs.length < 2) return null;

  const tableState = new Map<string, TableSides>();
  const diagnostics: Db2LineageDiagnostic[] = [];

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
      const hostVars = extractHostVars(ref.rawText);
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
  };
  for (const d of diagnostics) diagnosticsByKind[d.kind]++;

  return {
    summary: { sharedTables, pairs: entries.length, diagnosticsByKind },
    entries,
    diagnostics,
  };
}
