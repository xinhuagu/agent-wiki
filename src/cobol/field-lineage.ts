import type { CobolCodeModel } from "./extractors.js";
import type { DataItemNode, SourceLocation } from "./types.js";
import { resolveCanonicalId, displayLabel } from "./graph.js";

export type LineageLinkage = "deterministic";
export type InferredLineageConfidence = "high" | "ambiguous";

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

function normalizeCopybookName(name: string): string {
  return resolveCanonicalId({ programId: "", sourceFile: name }).toUpperCase();
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

export function buildFieldLineage(models: CobolCodeModel[]): SerializedFieldLineage | null {
  const parsedCopybooks = models.filter((model) => isCopybook(model.sourceFile));
  const parsedPrograms = models.filter((model) => !isCopybook(model.sourceFile));
  if (parsedCopybooks.length === 0 || parsedPrograms.length === 0) return null;

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
        fieldCount: flattenDataItems(copybook.dataItems, copybookId, copybook.sourceFile).length,
      };
    }).filter((entry) => entry.programs.length > 0)
    .sort((a, b) => a.copybookId.localeCompare(b.copybookId));

  if (rawCopybookUsage.length === 0) return null;

  const flattenedByCopybook = new Map<string, FlattenedField[]>();
  for (const copybook of parsedCopybooks.filter((entry) => !duplicateLogicalNames.has(resolveCanonicalId(entry)))) {
    const copybookId = `copybook:${resolveCanonicalId(copybook)}`;
    const rootSiblingNames = copybook.dataItems.map((item) => item.name);
    flattenedByCopybook.set(
      copybookId,
      flattenDataItems(copybook.dataItems, copybookId, copybook.sourceFile, [], rootSiblingNames),
    );
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
    return null;
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
    },
    copybookUsage,
    deterministic: sortedDeterministic,
    inferredHighConfidence,
    inferredAmbiguous,
  };
}

export function generateFieldLineagePage(lineage: SerializedFieldLineage): { path: string; content: string } {
  const lines: string[] = [];
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
  ]);

  lines.push("---");
  lines.push('title: "COBOL Field Lineage"');
  lines.push("type: synthesis");
  lines.push("tags: [cobol, field-lineage, lineage]");
  lines.push(`sources: [${sources.join(", ")}]`);
  lines.push("---");
  lines.push("");

  lines.push("## Overview");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|--------|-------|");
  lines.push(`| Deterministic copybooks | ${lineage.summary.deterministic.copybooks} |`);
  lines.push(`| Deterministic programs | ${lineage.summary.deterministic.programs} |`);
  lines.push(`| Deterministic shared fields | ${lineage.summary.deterministic.fields} |`);
  lines.push(`| Inferred copybooks | ${lineage.summary.inferred.copybooks} |`);
  lines.push(`| Inferred programs | ${lineage.summary.inferred.programs} |`);
  lines.push(`| Inferred high-confidence candidates | ${lineage.summary.inferred.highConfidence} |`);
  lines.push(`| Inferred ambiguous candidates | ${lineage.summary.inferred.ambiguous} |`);
  lines.push("");

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

  return {
    path: "cobol/field-lineage.md",
    content: lines.join("\n"),
  };
}
