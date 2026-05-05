/**
 * Cross-program field lineage across CALL USING boundaries.
 *
 * Phase 2: build deterministic record-level lineage entries. For each parsed
 * caller's CALL site, when the callee resolves to a parsed program and arity
 * matches, link USING argument #N (resolved against the caller's data items)
 * to LINKAGE record #N in the callee. Field-level descent and weaker tiers
 * are out of scope for this phase.
 */

import type { CobolCodeModel } from "./extractors.js";
import type { DataItemNode, SourceLocation } from "./types.js";
import { resolveCanonicalId } from "./graph.js";

export type CallBoundConfidence = "deterministic";

export interface CallBoundFieldShape {
  fieldName: string;
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

function shapeOf(item: DataItemNode): CallBoundFieldShape {
  return {
    fieldName: item.name,
    level: item.level,
    picture: item.picture,
    usage: item.usage,
    isGroup: !item.picture && item.children.length > 0,
    childCount: item.children.length,
  };
}

function compareShape(
  caller: CallBoundFieldShape,
  callee: CallBoundFieldShape,
): CallBoundEvidence | null {
  if (caller.isGroup && callee.isGroup) {
    return {
      arityMatch: true,
      shapeMatch: "both-group",
      pictureMatch: true,
      levelMatch: caller.level === callee.level,
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
    };
  }
  return null;
}

function buildRationale(evidence: CallBoundEvidence, position: number): string {
  const parts = [`Position ${position}`];
  parts.push(evidence.shapeMatch === "both-group" ? "both group records" : "matching scalar PIC");
  if (evidence.levelMatch) parts.push("same level");
  return parts.join("; ");
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

      for (let i = 0; i < call.usingArgs.length; i++) {
        const callerArgName = call.usingArgs[i]!;
        const callerItem = findTopLevelDataItem(caller.dataItems, callerArgName);
        if (!callerItem) continue;
        const calleeRecord = callee.linkageItems[i]!;

        const callerShape = shapeOf(callerItem);
        const calleeShape = shapeOf(calleeRecord);
        const evidence = compareShape(callerShape, calleeShape);
        if (!evidence) continue;

        entries.push({
          confidence: "deterministic",
          position: i,
          caller: {
            ...callerShape,
            programId: `program:${resolveCanonicalId(caller)}`,
            sourceFile: caller.sourceFile,
          },
          callee: {
            ...calleeShape,
            programId: `program:${resolveCanonicalId(callee)}`,
            sourceFile: callee.sourceFile,
          },
          callSite: call.loc,
          evidence,
          rationale: buildRationale(evidence, i),
        });
      }
    }
  }

  if (entries.length === 0) return null;

  entries.sort((a, b) =>
    a.caller.programId.localeCompare(b.caller.programId)
    || a.callee.programId.localeCompare(b.callee.programId)
    || a.position - b.position
  );

  return {
    summary: {
      callSites,
      pairs: entries.length,
    },
    entries,
  };
}
