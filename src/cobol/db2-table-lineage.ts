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

export type Db2LineageConfidence = "deterministic";

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
  evidence: Db2LineageEvidence;
  rationale: string;
}

export interface Db2Lineage {
  summary: {
    sharedTables: number;
    pairs: number;
  };
  entries: SerializedDb2LineageEntry[];
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

  for (const program of programs) {
    const programId = `program:${resolveCanonicalId(program)}`;
    const sourceFile = program.sourceFile;
    for (const ref of program.db2References) {
      if (ref.tables.length === 0) continue;
      const op = ref.operation?.toUpperCase();
      const kind = classifyOp(op);
      if (!kind || !op) continue;
      const hostVars = extractHostVars(ref.rawText);
      for (const table of ref.tables) {
        bump(tableState, table, kind, programId, sourceFile, op, hostVars, ref.loc);
      }
    }
  }

  const entries: SerializedDb2LineageEntry[] = [];
  let sharedTables = 0;

  for (const [table, sides] of tableState.entries()) {
    if (sides.writers.size === 0 || sides.readers.size === 0) continue;
    sharedTables++;
    for (const writer of sides.writers.values()) {
      for (const reader of sides.readers.values()) {
        if (writer.programId === reader.programId) continue;
        const writerParticipant = toParticipant(writer);
        const readerParticipant = toParticipant(reader);
        const rationale =
          `${writerParticipant.programId.replace("program:", "")} writes to ${table} via ${writerParticipant.operations.join(",")}; `
          + `${readerParticipant.programId.replace("program:", "")} reads from ${table} via ${readerParticipant.operations.join(",")}.`;
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
          rationale,
        });
      }
    }
  }

  if (entries.length === 0) return null;

  entries.sort((a, b) =>
    a.table.localeCompare(b.table)
    || a.writer.programId.localeCompare(b.writer.programId)
    || a.reader.programId.localeCompare(b.reader.programId)
  );

  return {
    summary: { sharedTables, pairs: entries.length },
    entries,
  };
}
