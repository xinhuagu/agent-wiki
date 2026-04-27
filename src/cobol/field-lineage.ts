import type { CobolCodeModel } from "./extractors.js";
import type { DataItemNode, SourceLocation } from "./types.js";
import { resolveCanonicalId, displayLabel } from "./graph.js";

export type LineageLinkage = "deterministic" | "high-confidence" | "ambiguous";

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

export interface SerializedFieldLineage {
  summary: {
    copybooks: number;
    programs: number;
    deterministic: number;
    highConfidence: number;
    ambiguous: number;
  };
  copybookUsage: Array<{
    copybookId: string;
    sourceFile: string;
    fieldCount: number;
    programs: Array<{ id: string; sourceFile: string; copyLoc?: SourceLocation }>;
  }>;
  deterministic: SerializedFieldLineageEntry[];
  highConfidence: SerializedFieldLineageEntry[];
  ambiguous: SerializedFieldLineageEntry[];
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
    });
    if (item.children.length > 0) {
      fields.push(...flattenDataItems(item.children, copybookId, copybookSourceFile, path));
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
    return {
      copybookId,
      sourceFile: copybook.sourceFile,
      programs: consumers,
      fieldCount: flattenDataItems(copybook.dataItems, copybookId, copybook.sourceFile).length,
    };
  }).filter((entry) => entry.programs.length > 0)
    .sort((a, b) => a.copybookId.localeCompare(b.copybookId));

  if (rawCopybookUsage.length === 0) return null;

  const flattenedByCopybook = new Map<string, FlattenedField[]>();
  for (const copybook of parsedCopybooks.filter((entry) => !duplicateLogicalNames.has(resolveCanonicalId(entry)))) {
    const copybookId = `copybook:${resolveCanonicalId(copybook)}`;
    flattenedByCopybook.set(copybookId, flattenDataItems(copybook.dataItems, copybookId, copybook.sourceFile));
  }

  const deterministic: SerializedFieldLineageEntry[] = [];
  const candidateFields: Array<FlattenedField & { programs: FieldConsumer[] }> = [];

  for (const usage of rawCopybookUsage) {
    const fields = flattenedByCopybook.get(usage.copybookId) ?? [];
    const exactPrograms = usage.programs.filter((program) => !program.replacing || program.replacing.length === 0);
    for (const field of fields) {
      candidateFields.push({ ...field, programs: exactPrograms });
      if (exactPrograms.length < 2) continue;
      deterministic.push(buildEntry(
        "deterministic",
        [field],
        exactPrograms,
        "Exact parsed copybook field shared by multiple programs through COPY."
      ));
    }
  }

  const highConfidence: SerializedFieldLineageEntry[] = [];
  const bySignature = new Map<string, Array<FlattenedField & { programs: FieldConsumer[] }>>();
  for (const field of candidateFields) {
    const signature = [
      field.fieldName.toUpperCase(),
      field.picture?.toUpperCase() ?? "",
      field.usage?.toUpperCase() ?? "",
    ].join("|");
    const list = bySignature.get(signature) ?? [];
    list.push(field);
    bySignature.set(signature, list);
  }
  for (const fields of bySignature.values()) {
    const copybooks = sortUnique(fields.map((field) => field.copybookId));
    const programs = [...new Map(
      fields.flatMap((field) => field.programs)
        .map((program) => [`${program.id}@${program.sourceFile}`, program])
    ).values()];
    const hasTypeEvidence = fields.some((field) => Boolean(field.picture) || Boolean(field.usage));
    if (copybooks.length < 2 || programs.length < 2 || !hasTypeEvidence) continue;
    highConfidence.push(buildEntry(
      "high-confidence",
      fields,
      programs,
      "Same field name and PIC/USAGE observed across different copybooks used by different programs."
    ));
  }

  const ambiguous: SerializedFieldLineageEntry[] = [];
  const byFieldName = new Map<string, Array<FlattenedField & { programs: FieldConsumer[] }>>();
  for (const field of candidateFields) {
    const key = field.fieldName.toUpperCase();
    const list = byFieldName.get(key) ?? [];
    list.push(field);
    byFieldName.set(key, list);
  }
  for (const fields of byFieldName.values()) {
    const copybooks = sortUnique(fields.map((field) => field.copybookId));
    if (copybooks.length < 2) continue;
    const variants = sortUnique(fields.map((field) => [
      field.picture?.toUpperCase() ?? "",
      field.usage?.toUpperCase() ?? "",
    ].join("|")));
    const programs = [...new Map(
      fields.flatMap((field) => field.programs)
        .map((program) => [`${program.id}@${program.sourceFile}`, program])
    ).values()];
    if (variants.length < 2 || programs.length < 2) continue;
    ambiguous.push(buildEntry(
      "ambiguous",
      fields,
      programs,
      "Same field name appears with conflicting PIC/USAGE across different copybooks."
    ));
  }

  const sortedDeterministic = deterministic.sort((a, b) =>
    a.copybooks[0]!.id.localeCompare(b.copybooks[0]!.id) ||
    a.qualifiedNames[0]!.localeCompare(b.qualifiedNames[0]!)
  );
  const sortedHighConfidence = highConfidence.sort((a, b) =>
    a.fieldName.localeCompare(b.fieldName) ||
    a.copybooks[0]!.id.localeCompare(b.copybooks[0]!.id)
  );
  const sortedAmbiguous = ambiguous.sort((a, b) =>
    a.fieldName.localeCompare(b.fieldName) ||
    a.copybooks[0]!.id.localeCompare(b.copybooks[0]!.id)
  );

  if (sortedDeterministic.length === 0 && sortedHighConfidence.length === 0 && sortedAmbiguous.length === 0) {
    return null;
  }

  const participatingCopybookIds = new Set<string>();
  const participatingProgramIds = new Set<string>();
  for (const entry of [...sortedDeterministic, ...sortedHighConfidence, ...sortedAmbiguous]) {
    for (const copybook of entry.copybooks) participatingCopybookIds.add(copybook.id);
    for (const program of entry.programs) participatingProgramIds.add(program.id);
  }
  const copybookUsage = rawCopybookUsage
    .filter((entry) => participatingCopybookIds.has(entry.copybookId))
    .map((entry) => ({
      ...entry,
      programs: entry.programs.filter((program) => participatingProgramIds.has(program.id)),
    }))
    .filter((entry) => entry.programs.length > 0);

  return {
    summary: {
      copybooks: participatingCopybookIds.size,
      programs: participatingProgramIds.size,
      deterministic: sortedDeterministic.length,
      highConfidence: sortedHighConfidence.length,
      ambiguous: sortedAmbiguous.length,
    },
    copybookUsage,
    deterministic: sortedDeterministic,
    highConfidence: sortedHighConfidence,
    ambiguous: sortedAmbiguous,
  };
}

function formatPrograms(programs: Array<{ id: string }>): string {
  return programs.map((program) => displayLabel(program.id)).join(", ") || "—";
}

function formatCopybooks(copybooks: Array<{ id: string }>): string {
  return copybooks.map((copybook) => displayLabel(copybook.id)).join(", ") || "—";
}

export function generateFieldLineagePage(lineage: SerializedFieldLineage): { path: string; content: string } {
  const lines: string[] = [];
  const sources = sortUnique([
    ...lineage.copybookUsage.map((entry) => `"raw/${entry.sourceFile}"`),
    ...lineage.copybookUsage.flatMap((entry) => entry.programs.map((program) => `"raw/${program.sourceFile}"`)),
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
  lines.push(`| Parsed copybooks with consumers | ${lineage.summary.copybooks} |`);
  lines.push(`| Programs participating | ${lineage.summary.programs} |`);
  lines.push(`| Deterministic shared fields | ${lineage.summary.deterministic} |`);
  lines.push(`| High-confidence candidates | ${lineage.summary.highConfidence} |`);
  lines.push(`| Ambiguous collisions | ${lineage.summary.ambiguous} |`);
  lines.push("");

  lines.push("## Copybook Usage");
  lines.push("");
  lines.push("| Copybook | Programs | Field Count |");
  lines.push("|----------|----------|-------------|");
  for (const usage of lineage.copybookUsage) {
    lines.push(`| ${displayLabel(usage.copybookId)} | ${formatPrograms(usage.programs)} | ${usage.fieldCount} |`);
  }
  lines.push("");

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

  lines.push("## High-Confidence Candidates");
  lines.push("");
  if (lineage.highConfidence.length === 0) {
    lines.push("No high-confidence cross-copybook candidates found.");
  } else {
    lines.push("| Field | Copybooks | Programs | PIC | Rationale |");
    lines.push("|-------|-----------|----------|-----|-----------|");
    for (const entry of lineage.highConfidence) {
      lines.push(
        `| ${entry.fieldName} | ${formatCopybooks(entry.copybooks)} | ${formatPrograms(entry.programs)} | ${entry.pictures.join(", ") || "—"} | ${entry.rationale} |`
      );
    }
  }
  lines.push("");

  lines.push("## Ambiguous Collisions");
  lines.push("");
  if (lineage.ambiguous.length === 0) {
    lines.push("No ambiguous field-name collisions found.");
  } else {
    lines.push("| Field | Copybooks | Observed PIC/USAGE | Programs | Rationale |");
    lines.push("|-------|-----------|--------------------|----------|-----------|");
    for (const entry of lineage.ambiguous) {
      const variants = entry.pictures.length > 0 ? entry.pictures.join(", ") : "—";
      lines.push(
        `| ${entry.fieldName} | ${formatCopybooks(entry.copybooks)} | ${variants} | ${formatPrograms(entry.programs)} | ${entry.rationale} |`
      );
    }
  }
  lines.push("");

  return {
    path: "cobol/field-lineage.md",
    content: lines.join("\n"),
  };
}
