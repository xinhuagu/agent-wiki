/**
 * Cross-program field lineage across CALL USING boundaries.
 *
 * Phase 2: deterministic record-level lineage entries.
 * Phase 3: descend into matching group children by position, emit entries
 * tiered by name-suffix evidence (deterministic if names match after
 * stripping a short prefix, high if structure matches but names diverge).
 */

import type { CobolCodeModel } from "./extractors.js";
import type { DataItemNode, SourceLocation } from "./types.js";
import { resolveCanonicalId } from "./graph.js";
import { cobolTierToEvidence } from "./evidence-mapping.js";
import type { EvidenceEnvelope } from "../evidence.js";

export type CallBoundConfidence = "deterministic" | "high";

/**
 * Reasons a CALL site or USING-arg pair was excluded from `entries`. Each
 * silent skip in `buildCallBoundLineage` becomes one diagnostic so the user
 * can audit why their lineage trace stops at a particular boundary, instead
 * of guessing whether the data is missing or the analysis chose to drop it.
 */
export type CallBoundDiagnosticKind =
  | "unresolved-callee"        // CALL "FOO" but FOO not in corpus
  | "dynamic-call"             // CALL <identifier> (resolved at runtime)
  | "arity-mismatch"           // arg count != callee linkage record count
  | "shape-mismatch"           // caller/callee record shapes incompatible
  | "caller-arg-not-top-level"; // USING arg name not a top-level data item

export interface CallBoundDiagnostic {
  kind: CallBoundDiagnosticKind;
  callerProgramId: string;
  /** Callee name as written at the call site (literal stripped of quotes, or identifier). */
  target: string;
  callSite: SourceLocation;
  rationale: string;
}

export interface CallBoundFieldShape {
  fieldName: string;
  qualifiedName: string;
  level: number;
  picture?: string;
  usage?: string;
  isGroup: boolean;
  childCount: number;
}

export interface CallBoundParticipant extends CallBoundFieldShape {
  programId: string;
  sourceFile: string;
}

export interface CallBoundEvidence {
  arityMatch: boolean;
  shapeMatch: "both-group" | "scalar-match";
  pictureMatch: boolean;
  levelMatch: boolean;
  nameSuffixMatch: boolean;
}

export interface SerializedCallBoundLineageEntry {
  confidence: CallBoundConfidence;
  position: number;
  caller: CallBoundParticipant;
  callee: CallBoundParticipant;
  callSite: SourceLocation;
  /** Domain-specific evidence detail (shape match, picture match, etc.). */
  evidence: CallBoundEvidence;
  /**
   * Language-agnostic envelope derived from `confidence` via
   * `cobolTierToEvidence` — the consumer-facing summary that callers branch
   * on without parsing domain detail.
   */
  envelope: EvidenceEnvelope;
  rationale: string;
}

export interface CallBoundLineage {
  summary: {
    callSites: number;
    pairs: number;
    /** Total skipped sites — sum of `diagnostics` length, broken down per kind. */
    diagnosticsByKind: Record<CallBoundDiagnosticKind, number>;
  };
  entries: SerializedCallBoundLineageEntry[];
  diagnostics: CallBoundDiagnostic[];
}

function isCopybook(filename: string): boolean {
  return filename.toLowerCase().endsWith(".cpy");
}

function findTopLevelDataItem(items: DataItemNode[], name: string): DataItemNode | undefined {
  const upper = name.toUpperCase();
  return items.find((item) => item.name.toUpperCase() === upper);
}

function shapeOf(item: DataItemNode, qualifiedName: string): CallBoundFieldShape {
  return {
    fieldName: item.name,
    qualifiedName,
    level: item.level,
    picture: item.picture,
    usage: item.usage,
    isGroup: !item.picture && item.children.length > 0,
    childCount: item.children.length,
  };
}

const PREFIX_PATTERN = /^[A-Z]{1,4}-/;

function nameSuffix(name: string): string {
  const upper = name.toUpperCase();
  return PREFIX_PATTERN.test(upper) ? upper.replace(PREFIX_PATTERN, "") : upper;
}

function nameSuffixMatch(a: string, b: string): boolean {
  const upperA = a.toUpperCase();
  const upperB = b.toUpperCase();
  if (upperA === upperB) return true;
  const sa = nameSuffix(upperA);
  const sb = nameSuffix(upperB);
  return sa === sb && sa.length > 0;
}

function compareShape(
  caller: CallBoundFieldShape,
  callee: CallBoundFieldShape,
): CallBoundEvidence | null {
  const nameMatch = nameSuffixMatch(caller.fieldName, callee.fieldName);
  if (caller.isGroup && callee.isGroup) {
    return {
      arityMatch: true,
      shapeMatch: "both-group",
      pictureMatch: true,
      levelMatch: caller.level === callee.level,
      nameSuffixMatch: nameMatch,
    };
  }
  if (!caller.isGroup && !callee.isGroup) {
    const callerPic = caller.picture?.toUpperCase() ?? "";
    const calleePic = callee.picture?.toUpperCase() ?? "";
    if (callerPic === "" || calleePic === "" || callerPic !== calleePic) {
      return null;
    }
    return {
      arityMatch: true,
      shapeMatch: "scalar-match",
      pictureMatch: true,
      levelMatch: caller.level === callee.level,
      nameSuffixMatch: nameMatch,
    };
  }
  return null;
}

function buildRationale(
  evidence: CallBoundEvidence,
  position: number,
  isTopLevel: boolean,
): string {
  const parts = [`Position ${position}`];
  parts.push(evidence.shapeMatch === "both-group" ? "both group records" : "matching scalar PIC");
  if (evidence.levelMatch) parts.push("same level");
  if (evidence.nameSuffixMatch) parts.push("matching name suffix");
  else if (!isTopLevel) parts.push("name suffix differs");
  return parts.join("; ");
}

function emitPair(
  callerItem: DataItemNode,
  calleeItem: DataItemNode,
  callerQualified: string,
  calleeQualified: string,
  position: number,
  isTopLevel: boolean,
  callerProgramId: string,
  calleeProgramId: string,
  callerSourceFile: string,
  calleeSourceFile: string,
  callSite: SourceLocation,
  calleeName: string,
  entries: SerializedCallBoundLineageEntry[],
  diagnostics: CallBoundDiagnostic[],
): void {
  const callerShape = shapeOf(callerItem, callerQualified);
  const calleeShape = shapeOf(calleeItem, calleeQualified);
  const evidence = compareShape(callerShape, calleeShape);
  if (!evidence) {
    // Only surface shape-mismatch at top level — descending into children of
    // an already-emitted group, then mismatching, is a routine outcome of the
    // structural match and would flood the diagnostic list with noise.
    if (isTopLevel) {
      diagnostics.push({
        kind: "shape-mismatch",
        callerProgramId,
        target: calleeName,
        callSite,
        rationale:
          `Position ${position}: caller \`${callerQualified}\` and callee `
          + `\`${calleeQualified}\` have incompatible shapes `
          + `(group/scalar mix or differing PICTURE).`,
      });
    }
    return;
  }

  const confidence: CallBoundConfidence =
    isTopLevel || evidence.nameSuffixMatch ? "deterministic" : "high";

  entries.push({
    confidence,
    position,
    caller: {
      ...callerShape,
      programId: callerProgramId,
      sourceFile: callerSourceFile,
    },
    callee: {
      ...calleeShape,
      programId: calleeProgramId,
      sourceFile: calleeSourceFile,
    },
    callSite,
    evidence,
    envelope: buildEnvelope(confidence, callerSourceFile, calleeSourceFile, callSite.line),
    rationale: buildRationale(evidence, position, isTopLevel),
  });

  if (callerShape.isGroup && calleeShape.isGroup) {
    const pairs = Math.min(callerItem.children.length, calleeItem.children.length);
    for (let k = 0; k < pairs; k++) {
      const childCaller = callerItem.children[k]!;
      const childCallee = calleeItem.children[k]!;
      emitPair(
        childCaller,
        childCallee,
        `${callerQualified}.${childCaller.name}`,
        `${calleeQualified}.${childCallee.name}`,
        position,
        false,
        callerProgramId,
        calleeProgramId,
        callerSourceFile,
        calleeSourceFile,
        callSite,
        calleeName,
        entries,
        diagnostics,
      );
    }
  }
}

function buildEnvelope(
  confidence: CallBoundConfidence,
  callerSourceFile: string,
  calleeSourceFile: string,
  line: number,
): EvidenceEnvelope {
  const tier = cobolTierToEvidence(confidence);
  return {
    confidence: tier.confidence,
    basis: tier.basis,
    abstain: tier.confidence === "absent",
    rationale:
      confidence === "deterministic"
        ? "Top-level CALL USING boundary or matching name suffix."
        : "Structural match across CALL USING boundary; names differ.",
    provenance: [
      { raw: callerSourceFile, line },
      { raw: calleeSourceFile },
    ],
  };
}

export function buildCallBoundLineage(models: CobolCodeModel[]): CallBoundLineage | null {
  const programs = models.filter((m) => !isCopybook(m.sourceFile));
  if (programs.length < 2) return null;

  const byProgramId = new Map<string, CobolCodeModel>();
  for (const model of programs) {
    byProgramId.set(resolveCanonicalId(model).toUpperCase(), model);
  }

  const entries: SerializedCallBoundLineageEntry[] = [];
  const diagnostics: CallBoundDiagnostic[] = [];
  let callSites = 0;

  for (const caller of programs) {
    const callerProgramId = `program:${resolveCanonicalId(caller)}`;
    for (const call of caller.calls) {
      // CALL with no USING args has no field lineage to extract — not a
      // diagnostic, just an empty trace.
      if (call.usingArgs.length === 0) continue;

      const callee = byProgramId.get(call.target.toUpperCase());
      if (!callee) {
        diagnostics.push({
          kind: call.targetKind === "identifier" ? "dynamic-call" : "unresolved-callee",
          callerProgramId,
          target: call.target,
          callSite: call.loc,
          rationale:
            call.targetKind === "identifier"
              ? `CALL via identifier \`${call.target}\` is resolved at runtime; static lineage cannot determine the callee.`
              : `CALL "${call.target}" has no matching program in the corpus.`,
        });
        continue;
      }

      if (callee.linkageItems.length !== call.usingArgs.length) {
        diagnostics.push({
          kind: "arity-mismatch",
          callerProgramId,
          target: call.target,
          callSite: call.loc,
          rationale:
            `CALL passes ${call.usingArgs.length} arg(s) but callee `
            + `\`${call.target}\` declares ${callee.linkageItems.length} `
            + `LINKAGE record(s).`,
        });
        continue;
      }

      callSites++;
      const calleeProgramId = `program:${resolveCanonicalId(callee)}`;

      for (let i = 0; i < call.usingArgs.length; i++) {
        const callerArgName = call.usingArgs[i]!;
        const callerItem = findTopLevelDataItem(caller.dataItems, callerArgName);
        if (!callerItem) {
          diagnostics.push({
            kind: "caller-arg-not-top-level",
            callerProgramId,
            target: call.target,
            callSite: call.loc,
            rationale:
              `Position ${i}: USING arg \`${callerArgName}\` is not a top-level `
              + `data item in caller \`${resolveCanonicalId(caller)}\`.`,
          });
          continue;
        }
        const calleeRecord = callee.linkageItems[i]!;

        emitPair(
          callerItem,
          calleeRecord,
          callerItem.name,
          calleeRecord.name,
          i,
          true,
          callerProgramId,
          calleeProgramId,
          caller.sourceFile,
          callee.sourceFile,
          call.loc,
          call.target,
          entries,
          diagnostics,
        );
      }
    }
  }

  if (entries.length === 0 && diagnostics.length === 0) return null;

  entries.sort((a, b) =>
    a.caller.programId.localeCompare(b.caller.programId)
    || a.callee.programId.localeCompare(b.callee.programId)
    || a.position - b.position
    || a.caller.qualifiedName.localeCompare(b.caller.qualifiedName)
  );

  const diagnosticsByKind: Record<CallBoundDiagnosticKind, number> = {
    "unresolved-callee": 0,
    "dynamic-call": 0,
    "arity-mismatch": 0,
    "shape-mismatch": 0,
    "caller-arg-not-top-level": 0,
  };
  for (const d of diagnostics) diagnosticsByKind[d.kind]++;

  return {
    summary: {
      callSites,
      pairs: entries.length,
      diagnosticsByKind,
    },
    entries,
    diagnostics,
  };
}
