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

export type CallBoundConfidence = "deterministic" | "high";

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
  evidence: CallBoundEvidence;
  rationale: string;
}

export interface CallBoundLineage {
  summary: {
    callSites: number;
    pairs: number;
  };
  entries: SerializedCallBoundLineageEntry[];
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
  entries: SerializedCallBoundLineageEntry[],
): void {
  const callerShape = shapeOf(callerItem, callerQualified);
  const calleeShape = shapeOf(calleeItem, calleeQualified);
  const evidence = compareShape(callerShape, calleeShape);
  if (!evidence) return;

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
        entries,
      );
    }
  }
}

export function buildCallBoundLineage(models: CobolCodeModel[]): CallBoundLineage | null {
  const programs = models.filter((m) => !isCopybook(m.sourceFile));
  if (programs.length < 2) return null;

  const byProgramId = new Map<string, CobolCodeModel>();
  for (const model of programs) {
    byProgramId.set(resolveCanonicalId(model).toUpperCase(), model);
  }

  const entries: SerializedCallBoundLineageEntry[] = [];
  let callSites = 0;

  for (const caller of programs) {
    for (const call of caller.calls) {
      if (call.usingArgs.length === 0) continue;
      const callee = byProgramId.get(call.target.toUpperCase());
      if (!callee) continue;
      if (callee.linkageItems.length !== call.usingArgs.length) continue;

      callSites++;
      const callerProgramId = `program:${resolveCanonicalId(caller)}`;
      const calleeProgramId = `program:${resolveCanonicalId(callee)}`;

      for (let i = 0; i < call.usingArgs.length; i++) {
        const callerArgName = call.usingArgs[i]!;
        const callerItem = findTopLevelDataItem(caller.dataItems, callerArgName);
        if (!callerItem) continue;
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
          entries,
        );
      }
    }
  }

  if (entries.length === 0) return null;

  entries.sort((a, b) =>
    a.caller.programId.localeCompare(b.caller.programId)
    || a.callee.programId.localeCompare(b.callee.programId)
    || a.position - b.position
    || a.caller.qualifiedName.localeCompare(b.caller.qualifiedName)
  );

  return {
    summary: {
      callSites,
      pairs: entries.length,
    },
    entries,
  };
}
