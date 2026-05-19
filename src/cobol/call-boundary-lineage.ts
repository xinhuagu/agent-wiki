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
import { resolveCanonicalId, normalizeCopybookName } from "./graph.js";
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
  | "caller-arg-not-top-level" // USING arg name not a top-level data item
  | "system-call";             // CALL into a documented IBM runtime API (#26)

/**
 * Names of IBM-published runtime APIs that are commonly invoked from
 * COBOL programs but should NOT be reported as `unresolved-callee` —
 * they are documented in IBM Knowledge Center, not user programs that
 * happen to be missing from the parsed corpus. Reporting them as system
 * calls keeps the diagnostic noise floor low so genuine user-program
 * gaps stand out.
 *
 * Source: IBM public documentation (IBM Knowledge Center / Redbooks).
 * Project-local additions are accepted via `.agent-wiki.local.yaml` so
 * site-specific runtime libraries don't get hardcoded into open source
 * (see #26 phase 2).
 */
export const SYSTEM_CALLEES: ReadonlySet<string> = new Set([
  // IBM MQ message-queue APIs
  "MQCONN", "MQDISC", "MQOPEN", "MQCLOSE",
  "MQGET", "MQPUT", "MQPUT1",
  "MQINQ", "MQSET",
  "MQBEGIN", "MQCMIT", "MQBACK",
  "MQSUB",
  // IBM MQ batch/CSQB interface
  "CSQBCON", "CSQBDIS",
  "CSQBOPN", "CSQBCLS",
  "CSQBGET", "CSQBPUT", "CSQBPUT1",
  // IBM Language Environment runtime callable services
  "CEE3ABD", "CEEDATE", "CEEDATM", "CEEDAYS",
  "CEELOCT", "CEEMSG", "CEEGTST",
]);

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
  /**
   * #46 Phase A — present when the CALL site target was an identifier
   * (dynamic call) that the resolver proved holds exactly one literal
   * program name (via VALUE clause OR exactly-one literal MOVE with no
   * non-literal writes). Lets the consumer distinguish "true literal
   * CALL" from "dynamic CALL resolved via constant propagation",
   * carrying the rename trail (identifier → literal, by which source).
   */
  dynamicCallResolution?: {
    identifier: string;
    literal: string;
    source: "VALUE" | "MOVE";
  };
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

/**
 * Recursive data-item lookup over a program's WS + LINKAGE trees. Used by
 * `resolveDynamicCallTarget` to check VALUE clauses on identifiers that
 * might live nested in a record. Different from `findTopLevelDataItem`
 * (used by USING-arg resolution which only accepts 01-level records) —
 * a program-name variable is just as likely to be `05 WS-PGM` inside
 * `01 WS-VARS` as `01 WS-PGM` at top level.
 */
function findDataItemAnywhere(items: DataItemNode[], name: string): DataItemNode | undefined {
  const upper = name.toUpperCase();
  for (const item of items) {
    if (item.name.toUpperCase() === upper) return item;
    const inner = findDataItemAnywhere(item.children, name);
    if (inner) return inner;
  }
  return undefined;
}

/**
 * Extract a string-literal value from a `DataItemNode.value` field. The
 * parser preserves quotes for LITERAL tokens (`VALUE "FOO"` lands as
 * `value === '"FOO"'`), so we recognise literals by the leading quote
 * and strip both ends. NUMERIC values and figurative-constant IDENTIFIER
 * values (`SPACES`, `ZEROES`, ...) return undefined — those aren't
 * usable program names for static CALL resolution.
 */
function extractStringLiteralValue(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (!/^["']/.test(raw)) return undefined;
  return raw.replace(/^["']|["']$/g, "");
}

/**
 * Resolve a `CALL <identifier>` target to a literal program name via
 * conservative constant propagation (#46 Phase A). Returns `null`
 * whenever the identifier doesn't uniquely hold a single literal value —
 * fail-safe to the existing `dynamic-call` diagnostic. Two patterns
 * succeed:
 *
 *   1. **Exactly one literal MOVE** to the identifier, with no
 *      non-literal MOVE to the same identifier anywhere in the program.
 *      Source classified as `"MOVE"`. If a VALUE clause also exists on
 *      the data item, it must agree with the MOVE literal — disagreement
 *      means two distinct possible values, so we abstain.
 *   2. **VALUE clause** initializer with a string literal, and no MOVE
 *      to the identifier at all. Source classified as `"VALUE"`.
 *
 * Anything else — multiple distinct literals, any non-literal MOVE,
 * disagreement between VALUE and MOVE, no value at all — returns null.
 * Multi-branch dispatch (`IF X MOVE "A" TO P ELSE MOVE "B"`) is Phase B
 * scope; it currently lands as "two distinct literals" and falls
 * through to the diagnostic.
 */
function resolveDynamicCallTarget(
  caller: CobolCodeModel,
  identifier: string,
): { literal: string; source: "VALUE" | "MOVE" } | null {
  const upper = identifier.toUpperCase();
  const assignments = caller.moveAssignments.filter(
    (a) => a.target.toUpperCase() === upper,
  );
  const dataItem = findDataItemAnywhere(caller.dataItems, identifier)
    ?? findDataItemAnywhere(caller.linkageItems, identifier);
  const valueLit = extractStringLiteralValue(dataItem?.value);

  if (assignments.length > 0) {
    // Any non-literal write disqualifies — we don't know what the
    // identifier holds at the call site.
    if (assignments.some((a) => a.literal === undefined)) return null;
    const uniqueLiterals = new Set(assignments.map((a) => a.literal!));
    if (uniqueLiterals.size !== 1) return null;
    const literal = [...uniqueLiterals][0]!;
    // A VALUE clause may coexist with MOVEs as long as it agrees with
    // the literal MOVE value. Disagreement = two distinct candidates.
    if (valueLit !== undefined && valueLit !== literal) return null;
    return { literal, source: "MOVE" };
  }

  if (valueLit !== undefined) {
    return { literal: valueLit, source: "VALUE" };
  }
  return null;
}

/**
 * Resolve a USING-arg name against a caller's full data surface — the
 * caller's own top-level data items first, then top-level items of any
 * copybook the caller COPYs. The parser does NOT inline-expand COPY,
 * so a `01` record declared inside a copybook never appears in
 * `caller.dataItems` even though it's visible to CALL USING. Without
 * the copybook fallback the analyzer fires a false
 * `caller-arg-not-top-level` for every COPY-supplied USING arg
 * (#26 phase 3).
 */
function resolveCallerArg(
  caller: CobolCodeModel,
  name: string,
  copybooksByLogicalName: Map<string, CobolCodeModel[]>,
): DataItemNode | undefined {
  const direct = findTopLevelDataItem(caller.dataItems, name);
  if (direct) return direct;
  for (const copy of caller.copies) {
    const copybooks = copybooksByLogicalName.get(normalizeCopybookName(copy.copybook));
    if (!copybooks) continue;
    for (const cpy of copybooks) {
      const item = findTopLevelDataItem(cpy.dataItems, name);
      if (item) return item;
    }
  }
  return undefined;
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
  dynamicCallResolution?: { identifier: string; literal: string; source: "VALUE" | "MOVE" },
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
    ...(dynamicCallResolution ? { dynamicCallResolution } : {}),
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
        dynamicCallResolution,
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

export function buildCallBoundLineage(
  models: CobolCodeModel[],
  options?: {
    /**
     * Additional callee names to treat as `system-call` rather than
     * `unresolved-callee` — site-specific runtime libraries that
     * shouldn't be hardcoded into the open-source whitelist (#26 phase 2).
     * Names are case-insensitive (matched after toUpperCase). Provided
     * by the caller (typically loaded from a gitignored
     * `.agent-wiki.local.yaml`); when omitted, only the built-in
     * `SYSTEM_CALLEES` set applies. Use `[...someSet]` to spread a Set
     * into an array if you have one in hand.
     */
    extraSystemCallees?: readonly string[];
  },
): CallBoundLineage | null {
  const programs = models.filter((m) => !isCopybook(m.sourceFile));
  if (programs.length < 2) return null;

  // Always rebuild as an uppercased Set regardless of input shape — Set
  // input is NOT pre-normalized by the caller, so a `new Set(["mqconn"])`
  // wouldn't match `"MQCONN"`. Iterating + uppercasing is cheap and
  // sidesteps the asymmetry.
  const extraSystemCalleesNorm: ReadonlySet<string> = options?.extraSystemCallees
    ? new Set([...options.extraSystemCallees].map((n) => n.toUpperCase()))
    : new Set<string>();

  const byProgramId = new Map<string, CobolCodeModel>();
  for (const model of programs) {
    byProgramId.set(resolveCanonicalId(model).toUpperCase(), model);
  }

  // #26 phase 3: index parsed copybooks so the USING-arg resolver can
  // fall back from a caller's own data items to the copybooks it
  // includes via COPY. Same pattern as the SQL host-var resolver in
  // db2-table-lineage.ts. Sort per-key list by sourceFile so duplicate
  // canonical names produce deterministic resolution.
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

  const entries: SerializedCallBoundLineageEntry[] = [];
  const diagnostics: CallBoundDiagnostic[] = [];
  let callSites = 0;
  // Per-build cache for resolveCallerArg lookups. Key = `${sourceFile}|${UPPER-NAME}`.
  // Value = resolved DataItemNode or undefined (the resolution itself can
  // be a negative result, which we cache too). Map.has check distinguishes
  // "absent" from "cached as undefined".
  const callerArgCache: Map<string, DataItemNode | undefined> = new Map();

  for (const caller of programs) {
    const callerProgramId = `program:${resolveCanonicalId(caller)}`;
    for (const call of caller.calls) {
      // CALL with no USING args has no field lineage to extract — not a
      // diagnostic, just an empty trace.
      if (call.usingArgs.length === 0) continue;

      // #46 Phase A — try to resolve a dynamic `CALL <identifier>` to a
      // literal program name via VALUE / single-MOVE constant propagation
      // BEFORE the byProgramId lookup. On success, the downstream code
      // treats this site like a literal CALL with `effectiveTarget` and
      // attaches a `dynamicCallResolution` evidence dimension to entries.
      // On failure, behavior is unchanged (still falls through to
      // `dynamic-call` diagnostic at the lookup).
      let effectiveTarget = call.target;
      let dynamicCallResolution:
        | { identifier: string; literal: string; source: "VALUE" | "MOVE" }
        | undefined;
      if (call.targetKind === "identifier") {
        const resolved = resolveDynamicCallTarget(caller, call.target);
        if (resolved) {
          effectiveTarget = resolved.literal;
          dynamicCallResolution = {
            identifier: call.target,
            literal: resolved.literal,
            source: resolved.source,
          };
        }
      }

      const callee = byProgramId.get(effectiveTarget.toUpperCase());
      if (!callee) {
        // Distinguish four cases (#46 Phase A added the dynamic-resolved
        // branches; resolved dynamic calls go through the literal-call
        // diagnostic paths because we know the target name now):
        //   1. CALL <var>             unresolved → dynamic-call
        //   2. CALL <var> → "IBM"     resolved   → system-call (whitelist)
        //   3. CALL "IBM"             literal    → system-call (whitelist)
        //   4. CALL "user"            literal    → unresolved-callee
        let kind: CallBoundDiagnosticKind;
        let rationale: string;
        if (call.targetKind === "identifier" && !dynamicCallResolution) {
          kind = "dynamic-call";
          rationale = `CALL via identifier \`${call.target}\` is resolved at runtime; static lineage cannot determine the callee. (No exactly-one literal MOVE or VALUE clause found for the identifier.)`;
        } else if (SYSTEM_CALLEES.has(effectiveTarget.toUpperCase())
          || extraSystemCalleesNorm.has(effectiveTarget.toUpperCase())) {
          kind = "system-call";
          const isExtra = !SYSTEM_CALLEES.has(effectiveTarget.toUpperCase());
          const baseRationale = isExtra
            ? `CALL "${effectiveTarget}" matches the project-local system-call extension (\`extraSystemCallees\`); excluded from user-program lineage.`
            : `CALL "${effectiveTarget}" targets a documented IBM runtime API (MQ / Language Environment / CICS-batch family); excluded from user-program lineage.`;
          rationale = dynamicCallResolution
            ? `${baseRationale} (Resolved from CALL \`${dynamicCallResolution.identifier}\` via ${dynamicCallResolution.source}.)`
            : baseRationale;
        } else {
          kind = "unresolved-callee";
          rationale = dynamicCallResolution
            ? `CALL via identifier \`${dynamicCallResolution.identifier}\` resolved to "${effectiveTarget}" (via ${dynamicCallResolution.source}) but no matching program in the corpus.`
            : `CALL "${effectiveTarget}" has no matching program in the corpus.`;
        }
        diagnostics.push({
          kind,
          callerProgramId,
          target: effectiveTarget,
          callSite: call.loc,
          rationale,
        });
        continue;
      }

      // #26 phase 4: CICS DFHCOMMAREA convention. CICS programs
      // conventionally accept a single implicit communication record
      // (`01 DFHCOMMAREA` in LINKAGE) — even when the LINKAGE SECTION
      // also declares additional records (DFHEIBLK, work buffers).
      // Treating raw `linkageItems.length` as the canonical arity in
      // that case fires a false `arity-mismatch` for callers that
      // correctly pass exactly one record.
      //
      // When the callee has a DFHCOMMAREA item AND the caller passes
      // exactly one USING arg, narrow the effective linkage list to
      // just DFHCOMMAREA. Multi-arg CICS calls (rare) fall through to
      // standard pair-by-position handling. No-DFHCOMMAREA callees are
      // unaffected.
      let effectiveLinkage: typeof callee.linkageItems = callee.linkageItems;
      const hasDfhCommarea = callee.linkageItems.some(
        (item) => item.name.toUpperCase() === "DFHCOMMAREA",
      );
      if (
        hasDfhCommarea
        && call.usingArgs.length === 1
        && callee.linkageItems.length !== 1
      ) {
        effectiveLinkage = callee.linkageItems.filter(
          (item) => item.name.toUpperCase() === "DFHCOMMAREA",
        );
      }

      if (effectiveLinkage.length !== call.usingArgs.length) {
        diagnostics.push({
          kind: "arity-mismatch",
          callerProgramId,
          target: effectiveTarget,
          callSite: call.loc,
          rationale:
            `CALL passes ${call.usingArgs.length} arg(s) but callee `
            + `\`${effectiveTarget}\` declares ${callee.linkageItems.length} `
            + `LINKAGE record(s).`,
        });
        continue;
      }

      callSites++;
      const calleeProgramId = `program:${resolveCanonicalId(callee)}`;

      for (let i = 0; i < call.usingArgs.length; i++) {
        const callerArgName = call.usingArgs[i]!;
        // Memoize per-(caller, upper-name) so a program with N calls
        // each passing the same record doesn't re-walk the copybook
        // tree N times. Cache lives for one buildCallBoundLineage
        // invocation; safe because resolveCallerArg is pure given
        // (caller, name, copybooksByLogicalName).
        const cacheKey = `${caller.sourceFile}|${callerArgName.toUpperCase()}`;
        let callerItem = callerArgCache.get(cacheKey);
        if (callerItem === undefined && !callerArgCache.has(cacheKey)) {
          callerItem = resolveCallerArg(caller, callerArgName, copybooksByLogicalName);
          callerArgCache.set(cacheKey, callerItem);
        }
        if (!callerItem) {
          diagnostics.push({
            kind: "caller-arg-not-top-level",
            callerProgramId,
            target: effectiveTarget,
            callSite: call.loc,
            rationale:
              `Position ${i}: USING arg \`${callerArgName}\` is not a top-level `
              + `data item in caller \`${resolveCanonicalId(caller)}\`.`,
          });
          continue;
        }
        const calleeRecord = effectiveLinkage[i]!;

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
          effectiveTarget,
          entries,
          diagnostics,
          dynamicCallResolution,
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
    "system-call": 0,
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
