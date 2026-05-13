import type { CobolCodeModel } from "./extractors.js";
import type { DataItemNode, SourceLocation } from "./types.js";
import { resolveCanonicalId, displayLabel, normalizeCopybookName } from "./graph.js";
import type { CallBoundLineage, SerializedCallBoundLineageEntry } from "./call-boundary-lineage.js";
import type { Db2Lineage, HostVarRef } from "./db2-table-lineage.js";

export type LineageLinkage = "deterministic";
export type InferredLineageConfidence = "high" | "ambiguous";

/**
 * Reasons a parsed COBOL model was flagged at lineage-build time. Distinct from
 * `CallBoundDiagnosticKind` / `Db2LineageDiagnosticKind` which describe
 * cross-program join failures — these describe the upstream inputs themselves.
 */
export type FieldLineageDiagnosticKind = "parsed-zero-data-items";

export interface FieldLineageDiagnostic {
  kind: FieldLineageDiagnosticKind;
  sourceFile: string;
  isCopybook: boolean;
  rationale: string;
}

export interface SerializedFieldLineageEntry {
  linkage: LineageLinkage;
  fieldName: string;
  qualifiedNames: string[];
  parentQualifiedNames: string[];
  copybooks: Array<{ id: string; sourceFile: string }>;
  programs: Array<{ id: string; sourceFile: string; copyLoc?: SourceLocation }>;
  pictures: string[];
  usages: string[];
  levels: number[];
  rationale: string;
}

export interface SerializedInferredFieldParticipant {
  copybook: { id: string; sourceFile: string };
  qualifiedName: string;
  parentQualifiedName?: string;
  picture?: string;
  usage?: string;
  level: number;
  programs: Array<{ id: string; sourceFile: string; copyLoc?: SourceLocation }>;
}

export interface SerializedInferredFieldEvidence {
  pictureMatch: boolean;
  usageEvidence: "explicit-match" | "both-missing";
  levelMatch: boolean;
  qualifiedNameMatch: "exact";
  parentContextMatch: "exact" | "suffix" | "top-level";
  siblingOverlap: string[];
  competingMatches: number;
}

export interface SerializedInferredFieldLineageEntry {
  confidence: InferredLineageConfidence;
  fieldName: string;
  left: SerializedInferredFieldParticipant;
  right: SerializedInferredFieldParticipant;
  evidence: SerializedInferredFieldEvidence;
  rationale: string;
}

export interface SerializedFieldLineage {
  summary: {
    deterministic: {
      copybooks: number;
      programs: number;
      fields: number;
    };
    inferred: {
      copybooks: number;
      programs: number;
      highConfidence: number;
      ambiguous: number;
    };
    diagnosticsByKind: Record<FieldLineageDiagnosticKind, number>;
  };
  copybookUsage: Array<{
    copybookId: string;
    sourceFile: string;
    fieldCount: number;
    programs: Array<{ id: string; sourceFile: string; copyLoc?: SourceLocation }>;
  }>;
  deterministic: SerializedFieldLineageEntry[];
  inferredHighConfidence: SerializedInferredFieldLineageEntry[];
  inferredAmbiguous: SerializedInferredFieldLineageEntry[];
  diagnostics: FieldLineageDiagnostic[];
  callBoundLineage?: CallBoundLineage | null;
  db2Lineage?: Db2Lineage | null;
}

export interface FieldLineageAttachments {
  callBound?: CallBoundLineage | null;
  db2?: Db2Lineage | null;
}

function emptyDiagnosticsByKind(): Record<FieldLineageDiagnosticKind, number> {
  return { "parsed-zero-data-items": 0 };
}

function countDiagnosticsByKind(
  diagnostics: FieldLineageDiagnostic[],
): Record<FieldLineageDiagnosticKind, number> {
  const counts = emptyDiagnosticsByKind();
  for (const d of diagnostics) counts[d.kind]++;
  return counts;
}

/**
 * Fill in field-lineage fields that older on-disk artifacts (pre-#30) don't
 * carry. Loaders should run any JSON parsed from `field-lineage.json` through
 * this before treating it as a `SerializedFieldLineage` — the interface
 * declares the new fields non-optional, so a raw cast would silently lie.
 */
export function normalizeLoadedFieldLineage(raw: SerializedFieldLineage): SerializedFieldLineage {
  const summary = raw.summary;
  return {
    ...raw,
    summary: {
      ...summary,
      diagnosticsByKind: summary.diagnosticsByKind ?? emptyDiagnosticsByKind(),
    },
    diagnostics: raw.diagnostics ?? [],
  };
}

function emptyCopybookLineage(): SerializedFieldLineage {
  return {
    summary: {
      deterministic: { copybooks: 0, programs: 0, fields: 0 },
      inferred: { copybooks: 0, programs: 0, highConfidence: 0, ambiguous: 0 },
      diagnosticsByKind: emptyDiagnosticsByKind(),
    },
    copybookUsage: [],
    deterministic: [],
    inferredHighConfidence: [],
    inferredAmbiguous: [],
    diagnostics: [],
  };
}

export function combineFieldLineage(
  copybookLineage: SerializedFieldLineage | null,
  attachments: FieldLineageAttachments = {},
): SerializedFieldLineage | null {
  const callBound = attachments.callBound ?? null;
  const db2 = attachments.db2 ?? null;
  if (!copybookLineage && !callBound && !db2) return null;
  const base = copybookLineage ?? emptyCopybookLineage();
  return {
    ...base,
    callBoundLineage: callBound,
    db2Lineage: db2,
  };
}

/** @deprecated kept for compatibility — prefer combineFieldLineage. */
export function attachCallBoundLineage(
  copybookLineage: SerializedFieldLineage | null,
  callLineage: CallBoundLineage | null,
): SerializedFieldLineage | null {
  return combineFieldLineage(copybookLineage, { callBound: callLineage });
}

interface FieldConsumer {
  id: string;
  sourceFile: string;
  copyLoc?: SourceLocation;
  replacing?: string[];
}

interface FlattenedField {
  copybookId: string;
  copybookSourceFile: string;
  fieldName: string;
  qualifiedName: string;
  parentQualifiedName?: string;
  picture?: string;
  usage?: string;
  level: number;
  siblings: string[];
}

interface InferredCandidate {
  fieldName: string;
  left: FlattenedField;
  right: FlattenedField;
  leftPrograms: FieldConsumer[];
  rightPrograms: FieldConsumer[];
  evidence: Omit<SerializedInferredFieldEvidence, "competingMatches">;
}

function isCopybook(filename: string): boolean {
  return filename.toLowerCase().endsWith(".cpy");
}

function flattenDataItems(
  items: DataItemNode[],
  copybookId: string,
  copybookSourceFile: string,
  parents: string[] = [],
  siblingNames: string[] = [],
): FlattenedField[] {
  const fields: FlattenedField[] = [];
  for (const item of items) {
    const path = [...parents, item.name];
    const qualifiedName = path.join(".");
    fields.push({
      copybookId,
      copybookSourceFile,
      fieldName: item.name,
      qualifiedName,
      parentQualifiedName: parents.length > 0 ? parents.join(".") : undefined,
      picture: item.picture,
      usage: item.usage,
      level: item.level,
      siblings: siblingNames.filter((name) => name !== item.name),
    });
    if (item.children.length > 0) {
      const childNames = item.children.map((child) => child.name);
      fields.push(...flattenDataItems(item.children, copybookId, copybookSourceFile, path, childNames));
    }
  }
  return fields;
}

function sortUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function compareProgram(a: FieldConsumer, b: FieldConsumer): number {
  return a.id.localeCompare(b.id) || a.sourceFile.localeCompare(b.sourceFile);
}

function compareCopybook(
  a: { id: string; sourceFile: string },
  b: { id: string; sourceFile: string },
): number {
  return a.id.localeCompare(b.id) || a.sourceFile.localeCompare(b.sourceFile);
}

function buildEntry(
  linkage: LineageLinkage,
  fields: FlattenedField[],
  programs: FieldConsumer[],
  rationale: string,
): SerializedFieldLineageEntry {
  const copybooks = [...new Map(
    fields.map((field) => [field.copybookId, { id: field.copybookId, sourceFile: field.copybookSourceFile }])
  ).values()].sort(compareCopybook);

  return {
    linkage,
    fieldName: fields[0]?.fieldName ?? "",
    qualifiedNames: sortUnique(fields.map((field) => field.qualifiedName)),
    parentQualifiedNames: sortUnique(
      fields
        .map((field) => field.parentQualifiedName)
        .filter((value): value is string => Boolean(value))
    ),
    copybooks,
    programs: [...programs].sort(compareProgram),
    pictures: sortUnique(fields.map((field) => field.picture).filter((value): value is string => Boolean(value))),
    usages: sortUnique(fields.map((field) => field.usage).filter((value): value is string => Boolean(value))),
    levels: [...new Set(fields.map((field) => field.level))].sort((a, b) => a - b),
    rationale,
  };
}

function compareField(a: FlattenedField, b: FlattenedField): number {
  return a.copybookId.localeCompare(b.copybookId)
    || a.qualifiedName.localeCompare(b.qualifiedName)
    || a.copybookSourceFile.localeCompare(b.copybookSourceFile);
}

function compareParticipant(
  a: SerializedInferredFieldParticipant,
  b: SerializedInferredFieldParticipant,
): number {
  return compareCopybook(a.copybook, b.copybook)
    || a.qualifiedName.localeCompare(b.qualifiedName);
}

function qualifiedSuffix(name: string): string {
  const parts = name.split(".");
  return parts.length > 1 ? parts.slice(1).join(".") : name;
}

function parentSuffix(name?: string): string | undefined {
  if (!name) return undefined;
  const parts = name.split(".");
  return parts.length > 1 ? parts.slice(1).join(".") : "";
}

function normalizeUsage(usage?: string): string {
  return usage?.toUpperCase() ?? "";
}

function normalizePicture(picture?: string): string {
  return picture?.toUpperCase() ?? "";
}

function determineParentContextMatch(
  left: FlattenedField,
  right: FlattenedField,
): "exact" | "suffix" | "top-level" | "none" {
  const leftParent = parentSuffix(left.parentQualifiedName);
  const rightParent = parentSuffix(right.parentQualifiedName);
  if (leftParent === undefined || rightParent === undefined) {
    return leftParent === rightParent ? "top-level" : "none";
  }
  if (leftParent === rightParent) {
    return leftParent === "" ? "top-level" : "exact";
  }
  if (leftParent && rightParent && (leftParent.endsWith(`.${rightParent}`) || rightParent.endsWith(`.${leftParent}`))) {
    return "suffix";
  }
  return "none";
}

function buildInferredParticipant(
  field: FlattenedField,
  programs: FieldConsumer[],
): SerializedInferredFieldParticipant {
  return {
    copybook: { id: field.copybookId, sourceFile: field.copybookSourceFile },
    qualifiedName: field.qualifiedName,
    parentQualifiedName: field.parentQualifiedName,
    picture: field.picture,
    usage: field.usage,
    level: field.level,
    programs: [...programs].sort(compareProgram),
  };
}

function inferredCandidateKey(field: FlattenedField): string {
  return `${field.copybookId}:${field.qualifiedName}`;
}

function buildInferredEntry(
  candidate: InferredCandidate,
  confidence: InferredLineageConfidence,
  competingMatches: number,
): SerializedInferredFieldLineageEntry {
  const left = buildInferredParticipant(candidate.left, candidate.leftPrograms);
  const right = buildInferredParticipant(candidate.right, candidate.rightPrograms);
  const ordered = compareParticipant(left, right) <= 0
    ? { left, right }
    : { left: right, right: left };
  const evidence: SerializedInferredFieldEvidence = {
    ...candidate.evidence,
    competingMatches,
  };

  const rationaleParts = [
    "Same field name",
    evidence.pictureMatch ? "matching PIC" : undefined,
    evidence.usageEvidence === "explicit-match" ? "matching USAGE" : undefined,
    evidence.levelMatch ? `same level ${ordered.left.level}` : undefined,
    evidence.parentContextMatch === "exact"
      ? "matching parent structure"
      : evidence.parentContextMatch === "suffix"
        ? "compatible parent structure"
        : evidence.parentContextMatch === "top-level"
          ? "both are direct children of the root record"
          : undefined,
    evidence.siblingOverlap.length > 0
      ? `shared sibling context: ${evidence.siblingOverlap.join(", ")}`
      : undefined,
    competingMatches > 0 ? `${competingMatches} competing match(es)` : undefined,
  ].filter((value): value is string => Boolean(value));

  return {
    confidence,
    fieldName: candidate.fieldName,
    left: ordered.left,
    right: ordered.right,
    evidence,
    rationale: rationaleParts.join("; "),
  };
}

function formatPrograms(programs: Array<{ id: string }>): string {
  return programs.map((program) => displayLabel(program.id)).join(", ") || "—";
}

function formatCopybooks(copybooks: Array<{ id: string }>): string {
  return copybooks.map((copybook) => displayLabel(copybook.id)).join(", ") || "—";
}

function formatInferredPrograms(
  left: SerializedInferredFieldParticipant,
  right: SerializedInferredFieldParticipant,
): string {
  return `${displayLabel(left.copybook.id)}: ${formatPrograms(left.programs)}<br>${displayLabel(right.copybook.id)}: ${formatPrograms(right.programs)}`;
}

function formatInferredStructure(
  participant: SerializedInferredFieldParticipant,
): string {
  return participant.parentQualifiedName
    ? `${participant.parentQualifiedName}.${participant.qualifiedName.split(".").pop()}`
    : participant.qualifiedName;
}

/**
 * Render a host-var list cell for the DB2 lineage table. Resolved vars
 * carry their PIC (or `group` if a record-level item) so the reader can
 * eyeball type alignment with the SQL column; when the field came from a
 * copybook, the origin is appended as `from CUSTID` so the user can trace
 * it without grepping. Unresolved vars are tagged with `(?)` — a paired
 * `host-var-unresolved` diagnostic in the exclusions table tells the
 * user why. `<br>` separates entries so a many-host-var cell stays
 * readable in the markdown table.
 */
function formatHostVars(hostVars: HostVarRef[]): string {
  if (hostVars.length === 0) return "—";
  return hostVars.map((hv) => {
    if (!hv.dataItem) return `\`${hv.name}\` (?)`;
    const shape = hv.dataItem.picture ?? "group";
    const origin = hv.dataItem.originCopybook
      ? ` from \`${hv.dataItem.originCopybook}\``
      : "";
    return `\`${hv.name}\` (${shape}${origin})`;
  }).join("<br>");
}

export function buildFieldLineage(models: CobolCodeModel[]): SerializedFieldLineage | null {
  const parsedCopybooks = models.filter((model) => isCopybook(model.sourceFile));
  const parsedPrograms = models.filter((model) => !isCopybook(model.sourceFile));

  // Flatten every copybook once; reused for the zero-data-items diagnostic,
  // `fieldCount` in `rawCopybookUsage`, and the inferred-candidate set below.
  // Pre-fix we called `flattenDataItems` three times per copybook (the latter
  // two only over the dup-filtered subset, but the diagnostic loop over all).
  const flattenedByCopybook = new Map<string, FlattenedField[]>();
  for (const copybook of parsedCopybooks) {
    const copybookId = `copybook:${resolveCanonicalId(copybook)}`;
    const rootSiblingNames = copybook.dataItems.map((item) => item.name);
    flattenedByCopybook.set(
      copybookId,
      flattenDataItems(copybook.dataItems, copybookId, copybook.sourceFile, [], rootSiblingNames),
    );
  }

  // #30 — surface copybooks whose parsed AST yields zero flattened fields.
  // The canonical case is listing-extracted copybooks where header text at
  // columns other than 7 escapes the comment filter (pre-#28). They were
  // silently dropped from every lineage family because rawCopybookUsage
  // filters by fieldCount; the user couldn't distinguish "no shared usage"
  // from "the copybook itself didn't parse." Only .cpy is diagnosed — a
  // .cbl program with zero WORKING-STORAGE data items is legitimate
  // (PROCEDURE-only / LINKAGE-only programs).
  const diagnostics: FieldLineageDiagnostic[] = [];
  for (const copybook of parsedCopybooks) {
    const copybookId = `copybook:${resolveCanonicalId(copybook)}`;
    if ((flattenedByCopybook.get(copybookId) ?? []).length === 0) {
      diagnostics.push({
        kind: "parsed-zero-data-items",
        sourceFile: copybook.sourceFile,
        isCopybook: true,
        rationale:
          "Parser produced 0 data items — listing-extracted header, "
          + "88-level-only fragment, pure COPY chain, or unsupported format.",
      });
    }
  }
  const withDiagnostics = (base: SerializedFieldLineage): SerializedFieldLineage => ({
    ...base,
    summary: {
      ...base.summary,
      diagnosticsByKind: countDiagnosticsByKind(diagnostics),
    },
    diagnostics,
  });

  if (parsedCopybooks.length === 0 || parsedPrograms.length === 0) {
    return diagnostics.length > 0 ? withDiagnostics(emptyCopybookLineage()) : null;
  }

  const copybooksByLogicalName = new Map<string, CobolCodeModel[]>();
  for (const copybook of parsedCopybooks) {
    const logicalName = resolveCanonicalId(copybook);
    const list = copybooksByLogicalName.get(logicalName) ?? [];
    list.push(copybook);
    copybooksByLogicalName.set(logicalName, list);
  }
  const duplicateLogicalNames = new Set(
    [...copybooksByLogicalName.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([logicalName]) => logicalName)
  );

  const consumersByCopybook = new Map<string, FieldConsumer[]>();
  for (const program of parsedPrograms) {
    const programId = `program:${resolveCanonicalId(program)}`;
    for (const copy of program.copies) {
      const key = normalizeCopybookName(copy.copybook);
      const list = consumersByCopybook.get(key) ?? [];
      list.push({
        id: programId,
        sourceFile: program.sourceFile,
        copyLoc: copy.loc,
        replacing: copy.replacing,
      });
      consumersByCopybook.set(key, list);
    }
  }

  const rawCopybookUsage = parsedCopybooks
    .filter((copybook) => !duplicateLogicalNames.has(resolveCanonicalId(copybook)))
    .map((copybook) => {
      const logicalName = resolveCanonicalId(copybook);
      const copybookId = `copybook:${logicalName}`;
      const consumers = [...new Map(
        (consumersByCopybook.get(normalizeCopybookName(logicalName)) ?? [])
          .map((consumer) => [`${consumer.id}@${consumer.sourceFile}`, consumer])
      ).values()].sort(compareProgram);
      const exactPrograms = consumers.filter((program) => !program.replacing || program.replacing.length === 0);
      return {
        copybookId,
        sourceFile: copybook.sourceFile,
        programs: consumers,
        exactPrograms,
        fieldCount: flattenedByCopybook.get(copybookId)?.length ?? 0,
      };
    }).filter((entry) => entry.programs.length > 0)
    .sort((a, b) => a.copybookId.localeCompare(b.copybookId));

  if (rawCopybookUsage.length === 0) {
    return diagnostics.length > 0 ? withDiagnostics(emptyCopybookLineage()) : null;
  }

  const deterministic: SerializedFieldLineageEntry[] = [];
  for (const usage of rawCopybookUsage) {
    const fields = flattenedByCopybook.get(usage.copybookId) ?? [];
    for (const field of fields) {
      if (usage.exactPrograms.length < 2) continue;
      deterministic.push(buildEntry(
        "deterministic",
        [field],
        usage.exactPrograms,
        "Exact parsed copybook field shared by multiple programs through COPY."
      ));
    }
  }

  const candidateFields = rawCopybookUsage.flatMap((usage) =>
    (flattenedByCopybook.get(usage.copybookId) ?? [])
      .filter((field) => usage.exactPrograms.length > 0)
      .filter((field) => Boolean(field.picture) || Boolean(field.usage))
      .map((field) => ({ field, programs: usage.exactPrograms }))
  );

  const candidateGroups = new Map<string, Array<{ field: FlattenedField; programs: FieldConsumer[] }>>();
  for (const candidate of candidateFields) {
    const key = candidate.field.fieldName.toUpperCase();
    const list = candidateGroups.get(key) ?? [];
    list.push(candidate);
    candidateGroups.set(key, list);
  }

  const inferredCandidates: InferredCandidate[] = [];
  for (const [fieldName, fields] of candidateGroups.entries()) {
    for (let i = 0; i < fields.length; i++) {
      for (let j = i + 1; j < fields.length; j++) {
        const left = fields[i]!;
        const right = fields[j]!;
        if (left.field.copybookId === right.field.copybookId) continue;
        if (compareField(left.field, right.field) > 0) continue;

        const pictureMatch = normalizePicture(left.field.picture) !== ""
          && normalizePicture(left.field.picture) === normalizePicture(right.field.picture);
        const leftUsage = normalizeUsage(left.field.usage);
        const rightUsage = normalizeUsage(right.field.usage);
        const usageEvidence = leftUsage !== "" && leftUsage === rightUsage
          ? "explicit-match"
          : leftUsage === "" && rightUsage === ""
            ? "both-missing"
            : null;
        const levelMatch = left.field.level === right.field.level;
        const qualifiedNameMatch = qualifiedSuffix(left.field.qualifiedName) === qualifiedSuffix(right.field.qualifiedName)
          ? "exact"
          : null;
        const parentContextMatch = determineParentContextMatch(left.field, right.field);
        const siblingOverlap = sortUnique(
          left.field.siblings.filter((sibling) => right.field.siblings.includes(sibling))
        );

        if (!pictureMatch || !usageEvidence || !levelMatch || qualifiedNameMatch !== "exact" || parentContextMatch === "none") {
          continue;
        }
        if (parentContextMatch === "top-level" && siblingOverlap.length === 0) {
          continue;
        }
        if (parentContextMatch === "suffix" && siblingOverlap.length === 0) {
          continue;
        }

        inferredCandidates.push({
          fieldName,
          left: left.field,
          right: right.field,
          leftPrograms: left.programs,
          rightPrograms: right.programs,
          evidence: {
            pictureMatch,
            usageEvidence,
            levelMatch,
            qualifiedNameMatch,
            parentContextMatch,
            siblingOverlap,
          },
        });
      }
    }
  }

  const candidateCounts = new Map<string, number>();
  for (const candidate of inferredCandidates) {
    candidateCounts.set(
      inferredCandidateKey(candidate.left),
      (candidateCounts.get(inferredCandidateKey(candidate.left)) ?? 0) + 1,
    );
    candidateCounts.set(
      inferredCandidateKey(candidate.right),
      (candidateCounts.get(inferredCandidateKey(candidate.right)) ?? 0) + 1,
    );
  }

  const inferredHighConfidence = inferredCandidates
    .map((candidate) => {
      const competingMatches = Math.max(
        (candidateCounts.get(inferredCandidateKey(candidate.left)) ?? 1) - 1,
        (candidateCounts.get(inferredCandidateKey(candidate.right)) ?? 1) - 1,
      );
      return { candidate, competingMatches };
    })
    .filter(({ competingMatches }) => competingMatches === 0)
    .map(({ candidate, competingMatches }) => buildInferredEntry(candidate, "high", competingMatches))
    .sort((a, b) =>
      compareCopybook(a.left.copybook, b.left.copybook)
      || a.left.qualifiedName.localeCompare(b.left.qualifiedName)
      || compareCopybook(a.right.copybook, b.right.copybook)
      || a.right.qualifiedName.localeCompare(b.right.qualifiedName)
    );

  const inferredAmbiguous = inferredCandidates
    .map((candidate) => {
      const competingMatches = Math.max(
        (candidateCounts.get(inferredCandidateKey(candidate.left)) ?? 1) - 1,
        (candidateCounts.get(inferredCandidateKey(candidate.right)) ?? 1) - 1,
      );
      return { candidate, competingMatches };
    })
    .filter(({ competingMatches }) => competingMatches > 0)
    .map(({ candidate, competingMatches }) => buildInferredEntry(candidate, "ambiguous", competingMatches))
    .sort((a, b) =>
      compareCopybook(a.left.copybook, b.left.copybook)
      || a.left.qualifiedName.localeCompare(b.left.qualifiedName)
      || compareCopybook(a.right.copybook, b.right.copybook)
      || a.right.qualifiedName.localeCompare(b.right.qualifiedName)
    );

  const sortedDeterministic = deterministic.sort((a, b) =>
    a.copybooks[0]!.id.localeCompare(b.copybooks[0]!.id) ||
    a.qualifiedNames[0]!.localeCompare(b.qualifiedNames[0]!)
  );

  if (sortedDeterministic.length === 0 && inferredHighConfidence.length === 0 && inferredAmbiguous.length === 0) {
    return diagnostics.length > 0 ? withDiagnostics(emptyCopybookLineage()) : null;
  }

  const participatingCopybookIds = new Set<string>();
  const participatingProgramIds = new Set<string>();
  const participatingProgramsByCopybook = new Map<string, Set<string>>();
  for (const entry of sortedDeterministic) {
    for (const copybook of entry.copybooks) participatingCopybookIds.add(copybook.id);
    for (const program of entry.programs) participatingProgramIds.add(program.id);
    for (const copybook of entry.copybooks) {
      const programIds = participatingProgramsByCopybook.get(copybook.id) ?? new Set<string>();
      for (const program of entry.programs) {
        programIds.add(program.id);
      }
      participatingProgramsByCopybook.set(copybook.id, programIds);
    }
  }

  const copybookUsage = rawCopybookUsage
    .filter((entry) => participatingCopybookIds.has(entry.copybookId))
    .map((entry) => ({
      copybookId: entry.copybookId,
      sourceFile: entry.sourceFile,
      fieldCount: entry.fieldCount,
      programs: entry.programs.filter((program) =>
        participatingProgramsByCopybook.get(entry.copybookId)?.has(program.id) ?? false
      ),
    }))
    .filter((entry) => entry.programs.length > 0);

  const inferredCopybookIds = new Set<string>();
  const inferredProgramIds = new Set<string>();
  for (const entry of [...inferredHighConfidence, ...inferredAmbiguous]) {
    inferredCopybookIds.add(entry.left.copybook.id);
    inferredCopybookIds.add(entry.right.copybook.id);
    for (const program of entry.left.programs) inferredProgramIds.add(program.id);
    for (const program of entry.right.programs) inferredProgramIds.add(program.id);
  }

  return {
    summary: {
      deterministic: {
        copybooks: participatingCopybookIds.size,
        programs: participatingProgramIds.size,
        fields: sortedDeterministic.length,
      },
      inferred: {
        copybooks: inferredCopybookIds.size,
        programs: inferredProgramIds.size,
        highConfidence: inferredHighConfidence.length,
        ambiguous: inferredAmbiguous.length,
      },
      diagnosticsByKind: countDiagnosticsByKind(diagnostics),
    },
    copybookUsage,
    deterministic: sortedDeterministic,
    inferredHighConfidence,
    inferredAmbiguous,
    diagnostics,
  };
}

export function generateFieldLineagePage(lineage: SerializedFieldLineage): { path: string; content: string } {
  const lines: string[] = [];
  const callBound = lineage.callBoundLineage ?? null;
  const db2 = lineage.db2Lineage ?? null;
  const sources = sortUnique([
    ...lineage.copybookUsage.map((entry) => `"raw/${entry.sourceFile}"`),
    ...lineage.copybookUsage.flatMap((entry) => entry.programs.map((program) => `"raw/${program.sourceFile}"`)),
    ...lineage.inferredHighConfidence.flatMap((entry) => [
      `"raw/${entry.left.copybook.sourceFile}"`,
      `"raw/${entry.right.copybook.sourceFile}"`,
      ...entry.left.programs.map((program) => `"raw/${program.sourceFile}"`),
      ...entry.right.programs.map((program) => `"raw/${program.sourceFile}"`),
    ]),
    ...lineage.inferredAmbiguous.flatMap((entry) => [
      `"raw/${entry.left.copybook.sourceFile}"`,
      `"raw/${entry.right.copybook.sourceFile}"`,
      ...entry.left.programs.map((program) => `"raw/${program.sourceFile}"`),
      ...entry.right.programs.map((program) => `"raw/${program.sourceFile}"`),
    ]),
    ...(callBound?.entries.flatMap((entry) => [
      `"raw/${entry.caller.sourceFile}"`,
      `"raw/${entry.callee.sourceFile}"`,
    ]) ?? []),
    ...(db2?.entries.flatMap((entry) => [
      `"raw/${entry.writer.sourceFile}"`,
      `"raw/${entry.reader.sourceFile}"`,
    ]) ?? []),
  ]);

  lines.push("---");
  lines.push('title: "COBOL Field Lineage"');
  lines.push("type: synthesis");
  lines.push("tags: [cobol, field-lineage, lineage]");
  lines.push(`sources: [${sources.join(", ")}]`);
  lines.push("---");
  lines.push("");

  const overviewHasCopybook = lineage.copybookUsage.length > 0
    || lineage.deterministic.length > 0
    || lineage.inferredHighConfidence.length > 0
    || lineage.inferredAmbiguous.length > 0;
  lines.push("## Overview");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|--------|-------|");
  if (overviewHasCopybook) {
    lines.push(`| Deterministic copybooks | ${lineage.summary.deterministic.copybooks} |`);
    lines.push(`| Deterministic programs | ${lineage.summary.deterministic.programs} |`);
    lines.push(`| Deterministic shared fields | ${lineage.summary.deterministic.fields} |`);
    lines.push(`| Inferred copybooks | ${lineage.summary.inferred.copybooks} |`);
    lines.push(`| Inferred programs | ${lineage.summary.inferred.programs} |`);
    lines.push(`| Inferred high-confidence candidates | ${lineage.summary.inferred.highConfidence} |`);
    lines.push(`| Inferred ambiguous candidates | ${lineage.summary.inferred.ambiguous} |`);
  }
  if (callBound) {
    lines.push(`| Call sites with USING args | ${callBound.summary.callSites} |`);
    lines.push(`| Call-bound field pairs | ${callBound.entries.length} |`);
  }
  if (db2) {
    lines.push(`| Shared DB2 tables | ${db2.summary.sharedTables} |`);
    lines.push(`| DB2 cross-program pairs | ${db2.entries.length} |`);
  }
  // Defensive `?.` — interface declares these non-optional, but renderer may
  // be invoked over a pre-#30 in-memory shape (e.g. test fixture, third-party
  // loader bypassing normalizeLoadedFieldLineage). Better to render a missing
  // count than crash.
  const zeroDataItemsCount = lineage.summary.diagnosticsByKind?.["parsed-zero-data-items"] ?? 0;
  if (zeroDataItemsCount > 0) {
    lines.push(`| Copybooks with zero parsed data items | ${zeroDataItemsCount} |`);
  }
  lines.push("");

  if (zeroDataItemsCount > 0) {
    lines.push("## Excluded Inputs");
    lines.push("");
    lines.push(
      "Copybooks whose parsed AST yielded no data items. Common causes: "
      + "listing-extracted header text at columns other than 7, 88-level-only "
      + "fragments, pure COPY chains, or unsupported formats.",
    );
    lines.push("");
    lines.push("| File | Kind | Rationale |");
    lines.push("|------|------|-----------|");
    const sortedDiagnostics = [...(lineage.diagnostics ?? [])].sort((a, b) =>
      a.sourceFile.localeCompare(b.sourceFile)
    );
    for (const d of sortedDiagnostics) {
      lines.push(`| \`raw/${d.sourceFile}\` | \`${d.kind}\` | ${d.rationale} |`);
    }
    lines.push("");
  }

  const hasCopybookContent = lineage.copybookUsage.length > 0
    || lineage.deterministic.length > 0
    || lineage.inferredHighConfidence.length > 0
    || lineage.inferredAmbiguous.length > 0;

  if (hasCopybookContent) {
    lines.push("## Copybook Usage");
    lines.push("");
    lines.push("Deterministic usage only. Inferred matches below do not affect these counts.");
    lines.push("");
    if (lineage.copybookUsage.length === 0) {
      lines.push("No deterministic shared-copybook usage found.");
      lines.push("");
    } else {
      lines.push("| Copybook | Programs | Field Count |");
      lines.push("|----------|----------|-------------|");
      for (const usage of lineage.copybookUsage) {
        lines.push(`| ${displayLabel(usage.copybookId)} | ${formatPrograms(usage.programs)} | ${usage.fieldCount} |`);
      }
      lines.push("");
    }

    lines.push("## Shared Copybook-Backed Fields");
    lines.push("");
    if (lineage.deterministic.length === 0) {
      lines.push("No deterministic shared fields found.");
    } else {
      lines.push("| Copybook | Field | Structure | Programs | PIC | Linkage |");
      lines.push("|----------|-------|-----------|----------|-----|---------|");
      for (const entry of lineage.deterministic) {
        lines.push(
          `| ${formatCopybooks(entry.copybooks)} | ${entry.fieldName} | ${entry.qualifiedNames.join("<br>")} | ${formatPrograms(entry.programs)} | ${entry.pictures.join(", ") || "—"} | ${entry.linkage} |`
        );
      }
    }
    lines.push("");

    lines.push("## Inferred Cross-Copybook Candidates");
    lines.push("");
    lines.push("These candidates are evidence-backed but not deterministic. They are intentionally separated from copybook usage and deterministic participation counts.");
    lines.push("");

    lines.push("### High Confidence");
    lines.push("");
    if (lineage.inferredHighConfidence.length === 0) {
      lines.push("No high-confidence inferred candidates found.");
    } else {
      lines.push("| Field | Left | Right | Programs | Evidence |");
      lines.push("|-------|------|-------|----------|----------|");
      for (const entry of lineage.inferredHighConfidence) {
        const evidence = [
          entry.evidence.parentContextMatch,
          entry.evidence.siblingOverlap.length > 0 ? `siblings: ${entry.evidence.siblingOverlap.join(", ")}` : undefined,
        ].filter((value): value is string => Boolean(value)).join("; ");
        lines.push(
          `| ${entry.fieldName} | ${displayLabel(entry.left.copybook.id)}<br>${formatInferredStructure(entry.left)} | ${displayLabel(entry.right.copybook.id)}<br>${formatInferredStructure(entry.right)} | ${formatInferredPrograms(entry.left, entry.right)} | ${evidence || "—"} |`
        );
      }
    }
    lines.push("");

    lines.push("### Ambiguous");
    lines.push("");
    if (lineage.inferredAmbiguous.length === 0) {
      lines.push("No ambiguous inferred candidates found.");
    } else {
      lines.push("| Field | Left | Right | Programs | Ambiguity |");
      lines.push("|-------|------|-------|----------|-----------|");
      for (const entry of lineage.inferredAmbiguous) {
        lines.push(
          `| ${entry.fieldName} | ${displayLabel(entry.left.copybook.id)}<br>${formatInferredStructure(entry.left)} | ${displayLabel(entry.right.copybook.id)}<br>${formatInferredStructure(entry.right)} | ${formatInferredPrograms(entry.left, entry.right)} | ${entry.evidence.competingMatches} competing match(es) |`
        );
      }
    }
    lines.push("");
  }

  if (callBound && (callBound.entries.length > 0 || callBound.diagnostics.length > 0)) {
    lines.push("## Call Boundary Field Lineage");
    lines.push("");
    lines.push(`Cross-program field flow at static \`CALL ... USING\` sites. Top-level entries link a caller's USING argument to the callee's matching LINKAGE record by position; child entries descend into matching group children. Confidence is \`deterministic\` when names align (after stripping a short prefix like \`WS-\`/\`LK-\`) and \`high\` when only structure aligns.`);
    lines.push("");
    // `callSites` only counts CALLs that resolved to a callee in the corpus
    // and matched arity. Sites blocked at those gates appear in the Excluded
    // subsection below — wording reflects this so a "0 call sites" display
    // doesn't mislead when the source actually has CALLs that all failed.
    const totalDiag = callBound.diagnostics.length;
    const coverage = totalDiag > 0
      ? `Coverage: ${callBound.summary.callSites} resolved call site(s), ${callBound.entries.length} field pair(s); ${totalDiag} excluded — see below.`
      : `Coverage: ${callBound.summary.callSites} call site(s), ${callBound.entries.length} field pair(s).`;
    lines.push(coverage);
    lines.push("");
    if (callBound.entries.length > 0) {
      const grouped = groupCallBoundByPair(callBound.entries);
      for (const group of grouped) {
        const detCount = group.entries.filter((e) => e.confidence === "deterministic").length;
        const highCount = group.entries.filter((e) => e.confidence === "high").length;
        lines.push(`### ${displayLabel(group.callerProgramId)} → ${displayLabel(group.calleeProgramId)}`);
        lines.push("");
        const summary = highCount > 0
          ? `${group.entries.length} pair(s): ${detCount} deterministic, ${highCount} high-confidence (name divergence — review below).`
          : `${group.entries.length} pair(s), all deterministic.`;
        lines.push(`*${summary}*`);
        lines.push("");
        lines.push("| Pos | Caller | Callee | Confidence | Evidence |");
        lines.push("|-----|--------|--------|------------|----------|");
        for (const entry of group.entries) {
          const evidence = [
            entry.evidence.shapeMatch,
            entry.evidence.nameSuffixMatch ? "name-aligned" : null,
            entry.evidence.levelMatch ? "same-level" : null,
          ].filter((value): value is string => Boolean(value)).join(", ");
          lines.push(
            `| ${entry.position} | ${entry.caller.qualifiedName} | ${entry.callee.qualifiedName} | ${entry.confidence} | ${evidence} |`
          );
        }
        lines.push("");
      }
    }
    if (callBound.diagnostics.length > 0) {
      renderCallBoundExclusions(lines, callBound.diagnostics);
    }
  }

  if (db2 && (db2.entries.length > 0 || db2.diagnostics.length > 0)) {
    lines.push("## DB2 Table Lineage");
    lines.push("");
    lines.push(`Cross-program field flow inferred from shared DB2 tables. A pair appears when one program writes to a table (\`INSERT\` / \`UPDATE\` / \`DELETE\` / \`MERGE\`) and another reads from it (\`SELECT\` / \`FETCH\`). Host variables on each side are listed; mapping them to specific columns requires a SQL parser and is out of scope here.`);
    lines.push("");
    const totalDb2Diag = db2.diagnostics.length;
    const db2Coverage = totalDb2Diag > 0
      ? `Coverage: ${db2.summary.sharedTables} shared table(s), ${db2.entries.length} writer→reader pair(s); ${totalDb2Diag} excluded — see below.`
      : `Coverage: ${db2.summary.sharedTables} shared table(s), ${db2.entries.length} writer→reader pair(s).`;
    lines.push(db2Coverage);
    lines.push("");
    if (db2.entries.length > 0) {
      lines.push("| Table | Writer | Writer Ops | Writer Host Vars | Reader | Reader Ops | Reader Host Vars |");
      lines.push("|-------|--------|------------|------------------|--------|------------|------------------|");
      for (const entry of db2.entries) {
        const writerVars = formatHostVars(entry.writer.hostVars);
        const readerVars = formatHostVars(entry.reader.hostVars);
        lines.push(
          `| ${entry.table} | ${displayLabel(entry.writer.programId)} | ${entry.writer.operations.join(", ")} | ${writerVars} | ${displayLabel(entry.reader.programId)} | ${entry.reader.operations.join(", ")} | ${readerVars} |`
        );
      }
      lines.push("");
    }
    if (db2.diagnostics.length > 0) {
      renderDb2Exclusions(lines, db2.diagnostics);
    }
  }

  return {
    path: "cobol/field-lineage.md",
    content: lines.join("\n"),
  };
}

// Fixed kind order for the rendered diagnostic table — orders rows by
// severity / "earliness in pipeline" so the user reads roughly upstream-to-
// downstream. Pinned here so the wiki page is byte-stable across rebuilds
// regardless of which diagnostic fired first in the parsed corpus.
//
// Typed against the union so removing a valid kind from the type fails
// typecheck. The renderer additionally falls back to rendering any kinds
// not listed here at the end of the table, so a future contributor adding
// a new kind doesn't silently drop its data — they'll see it appended,
// notice the missing pinned position, and update this array.
const CALL_BOUND_KIND_ORDER: readonly CallBoundLineage["diagnostics"][number]["kind"][] = [
  "unresolved-callee",
  "dynamic-call",
  "system-call",
  "arity-mismatch",
  "shape-mismatch",
  "caller-arg-not-top-level",
];

const DB2_KIND_ORDER: readonly Db2Lineage["diagnostics"][number]["kind"][] = [
  "non-classifiable-op",
  "writer-only",
  "reader-only",
  "self-loop",
  "host-var-unresolved",
];

/**
 * Render an "Excluded by diagnostic" subsection under a lineage family.
 * Counts per kind plus one sample so the user can see what's being skipped
 * without scrolling through hundreds of identical entries.
 */
function renderCallBoundExclusions(
  lines: string[],
  diagnostics: NonNullable<CallBoundLineage["diagnostics"]>,
): void {
  const byKind = new Map<string, { count: number; sample: typeof diagnostics[number] }>();
  for (const d of diagnostics) {
    const existing = byKind.get(d.kind);
    if (!existing) byKind.set(d.kind, { count: 1, sample: d });
    else existing.count++;
  }
  lines.push("### Excluded by diagnostic");
  lines.push("");
  lines.push(`${diagnostics.length} call site(s) or arg pair(s) excluded from the table above. Sample row per kind:`);
  lines.push("");
  lines.push("| Kind | Count | Sample |");
  lines.push("|------|-------|--------|");
  for (const kind of CALL_BOUND_KIND_ORDER) {
    const bucket = byKind.get(kind);
    if (!bucket) continue;
    const { count, sample } = bucket;
    const sampleText = `\`${sample.target}\` in ${displayLabel(sample.callerProgramId)} (line ${sample.callSite.line})`;
    lines.push(`| ${kind} | ${count} | ${sampleText} |`);
  }
  // Fallback: any kinds not in the pinned order render at the end (in
  // insertion order). Prevents silent data loss when a new kind is added
  // to the type union without updating CALL_BOUND_KIND_ORDER.
  const known = new Set<string>(CALL_BOUND_KIND_ORDER);
  for (const [kind, { count, sample }] of byKind) {
    if (known.has(kind)) continue;
    const sampleText = `\`${sample.target}\` in ${displayLabel(sample.callerProgramId)} (line ${sample.callSite.line})`;
    lines.push(`| ${kind} | ${count} | ${sampleText} |`);
  }
  lines.push("");
}

function renderDb2Exclusions(
  lines: string[],
  diagnostics: NonNullable<Db2Lineage["diagnostics"]>,
): void {
  const byKind = new Map<string, { count: number; sample: typeof diagnostics[number] }>();
  for (const d of diagnostics) {
    const existing = byKind.get(d.kind);
    if (!existing) byKind.set(d.kind, { count: 1, sample: d });
    else existing.count++;
  }
  lines.push("### Excluded by diagnostic");
  lines.push("");
  lines.push(`${diagnostics.length} reference(s) or table(s) excluded from the table above. Sample row per kind:`);
  lines.push("");
  lines.push("| Kind | Count | Sample |");
  lines.push("|------|-------|--------|");
  const renderRow = (
    kind: string,
    count: number,
    sample: { programId?: string; table?: string; operation?: string; hostVar?: string },
  ): void => {
    const parts: string[] = [];
    if (sample.programId) parts.push(displayLabel(sample.programId));
    if (sample.table) parts.push(`table \`${sample.table}\``);
    if (sample.operation) parts.push(`op \`${sample.operation}\``);
    if (sample.hostVar) parts.push(`host var \`:${sample.hostVar}\``);
    const sampleText = parts.length > 0 ? parts.join(", ") : "—";
    lines.push(`| ${kind} | ${count} | ${sampleText} |`);
  };
  for (const kind of DB2_KIND_ORDER) {
    const bucket = byKind.get(kind);
    if (!bucket) continue;
    renderRow(kind, bucket.count, bucket.sample);
  }
  // Fallback for kinds not in DB2_KIND_ORDER — see CALL renderer for rationale.
  const known = new Set<string>(DB2_KIND_ORDER);
  for (const [kind, { count, sample }] of byKind) {
    if (known.has(kind)) continue;
    renderRow(kind, count, sample);
  }
  lines.push("");
}

interface CallBoundGroup {
  callerProgramId: string;
  calleeProgramId: string;
  entries: SerializedCallBoundLineageEntry[];
}

function groupCallBoundByPair(entries: SerializedCallBoundLineageEntry[]): CallBoundGroup[] {
  const groups = new Map<string, CallBoundGroup>();
  for (const entry of entries) {
    const key = `${entry.caller.programId}→${entry.callee.programId}`;
    const group = groups.get(key);
    if (group) {
      group.entries.push(entry);
    } else {
      groups.set(key, {
        callerProgramId: entry.caller.programId,
        calleeProgramId: entry.callee.programId,
        entries: [entry],
      });
    }
  }
  return [...groups.values()].sort((a, b) =>
    a.callerProgramId.localeCompare(b.callerProgramId)
    || a.calleeProgramId.localeCompare(b.calleeProgramId)
  );
}
