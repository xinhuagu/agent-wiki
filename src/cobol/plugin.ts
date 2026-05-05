/**
 * COBOL code-analysis plugin — implements CodeAnalysisPlugin interface.
 *
 * Ties together lexer, parser, extractors, variable tracer, and wiki generator,
 * and normalizes COBOL-specific structures into the language-agnostic model.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parser.js";
import { extractModel, generateSummary } from "./extractors.js";
import { traceVariable as cobolTraceVariable, extractDataflowEdges, extractCallEdges } from "./variable-tracer.js";
import { combineFieldLineage, buildFieldLineage, generateFieldLineagePage } from "./field-lineage.js";
import { buildCallBoundLineage } from "./call-boundary-lineage.js";
import { buildDb2TableLineage } from "./db2-table-lineage.js";
import { generateProgramPage, generateCopybookPage, generateCallGraphPage } from "./wiki-gen.js";
import type { CobolAST, DataItemNode } from "./types.js";
import type { CobolCodeModel } from "./extractors.js";
import {
  resolveCanonicalId,
  canonicalNodeId,
  KnowledgeGraphBuilder,
  populateGraphFromCobol,
  serializeGraph,
  toMermaid,
  displayLabel,
} from "./graph.js";
import type { SerializedGraph, GraphNode } from "./graph.js";
import type {
  CodeAnalysisPlugin,
  NormalizedCodeModel,
  CodeUnit,
  CodeProcedure,
  CodeSymbol,
  CodeRelation,
  VariableReference,
} from "../code-analysis.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isCopybook(filename: string): boolean {
  return filename.toLowerCase().endsWith(".cpy");
}

/** Flatten nested data items into CodeSymbols. */
function flattenDataItems(items: DataItemNode[], parent?: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (const item of items) {
    const kind = item.level === 88 ? "condition"
      : item.children.length > 0 ? "group"
      : "variable";
    symbols.push({
      name: item.name,
      kind,
      dataType: item.picture,
      parentSymbol: parent,
      loc: item.loc,
    });
    if (item.children.length > 0) {
      symbols.push(...flattenDataItems(item.children, item.name));
    }
  }
  return symbols;
}

/**
 * Backfill missing array fields on a parsed model loaded from disk so
 * downstream consumers can rely on the current schema even when reading
 * artifacts produced by older releases.
 *
 * Defensive over the entire CobolCodeModel array surface: even though some
 * fields date back to the original schema, real-world deployments accumulate
 * artifacts from many releases — being narrow risks crashing on whichever
 * field happens to be missing in the oldest file. Fields added across phases
 * (linkageItems, db2References, cicsReferences, fileAccesses, calls[].usingArgs)
 * are the most likely to be absent, but this normalization covers all of them.
 */
export function migrateLoadedModel(raw: unknown): CobolCodeModel {
  const m = raw as Partial<CobolCodeModel> & Record<string, unknown>;
  if (!Array.isArray(m.divisions)) m.divisions = [];
  if (!Array.isArray(m.sections)) m.sections = [];
  if (!Array.isArray(m.paragraphs)) m.paragraphs = [];
  if (!Array.isArray(m.calls)) m.calls = [];
  if (!Array.isArray(m.performs)) m.performs = [];
  if (!Array.isArray(m.copies)) m.copies = [];
  if (!Array.isArray(m.dataItems)) m.dataItems = [];
  if (!Array.isArray(m.linkageItems)) m.linkageItems = [];
  if (!Array.isArray(m.fileDefinitions)) m.fileDefinitions = [];
  if (!Array.isArray(m.db2References)) m.db2References = [];
  if (!Array.isArray(m.cicsReferences)) m.cicsReferences = [];
  if (!Array.isArray(m.fileAccesses)) m.fileAccesses = [];
  for (const call of m.calls) {
    if (!Array.isArray((call as { usingArgs?: unknown }).usingArgs)) {
      (call as { usingArgs: string[] }).usingArgs = [];
    }
  }
  return m as CobolCodeModel;
}

function loadCobolModels(parsedDir: string): CobolCodeModel[] {
  const modelPaths: string[] = [];

  const walk = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".model.json")) continue;
      modelPaths.push(full);
    }
  };

  if (!existsSync(parsedDir)) return [];
  walk(parsedDir);

  const models: CobolCodeModel[] = [];
  for (const full of modelPaths.sort((a, b) => a.localeCompare(b))) {
    try {
      const raw = JSON.parse(readFileSync(full, "utf-8"));
      models.push(migrateLoadedModel(raw));
    } catch {
      // Skip malformed files
    }
  }
  return models;
}

// ---------------------------------------------------------------------------
// COBOL → NormalizedCodeModel
// ---------------------------------------------------------------------------

function cobolToNormalized(cobolModel: CobolCodeModel): NormalizedCodeModel {
  const canonicalId = resolveCanonicalId(cobolModel);
  const units: CodeUnit[] = [{
    name: canonicalId,
    kind: isCopybook(cobolModel.sourceFile) ? "copybook" : "program",
    language: "COBOL",
    sourceFile: cobolModel.sourceFile,
  }];

  const procedures: CodeProcedure[] = [];
  for (const sec of cobolModel.sections.filter((s) => s.division === "PROCEDURE")) {
    procedures.push({
      name: sec.name,
      kind: "section",
      parentUnit: cobolModel.programId,
      loc: sec.loc,
    });
  }
  for (const para of cobolModel.paragraphs) {
    procedures.push({
      name: para.name,
      kind: "paragraph",
      parentUnit: cobolModel.programId,
      parentProcedure: para.section,
      loc: para.loc,
    });
  }

  const symbols = flattenDataItems(cobolModel.dataItems);

  const relations: CodeRelation[] = [];
  for (const c of cobolModel.calls) {
    relations.push({
      type: "call",
      from: c.fromParagraph,
      to: c.target,
      loc: c.loc,
    });
  }
  for (const p of cobolModel.performs) {
    relations.push({
      type: "perform",
      from: p.fromParagraph,
      to: p.target,
      loc: p.loc,
      metadata: p.thru ? { thru: p.thru } : undefined,
    });
  }
  for (const c of cobolModel.copies) {
    relations.push({
      type: "include",
      from: canonicalId,
      to: c.copybook,
      loc: c.loc,
      metadata: c.replacing ? { replacing: c.replacing } : undefined,
    });
  }
  for (const db2 of cobolModel.db2References) {
    for (const table of db2.tables) {
      relations.push({
        type: "db2-table",
        from: canonicalId,
        to: table,
        loc: db2.loc,
        metadata: db2.operation ? { operation: db2.operation } : undefined,
      });
    }
  }
  for (const cics of cobolModel.cicsReferences) {
    if (cics.program) {
      relations.push({
        type: "cics-program",
        from: canonicalId,
        to: cics.program,
        loc: cics.loc,
        metadata: { command: cics.command },
      });
    }
    if (cics.transaction) {
      relations.push({
        type: "cics-transaction",
        from: canonicalId,
        to: cics.transaction,
        loc: cics.loc,
        metadata: { command: cics.command },
      });
    }
    if (cics.map) {
      relations.push({
        type: "cics-map",
        from: canonicalId,
        to: cics.map,
        loc: cics.loc,
        metadata: { command: cics.command },
      });
    }
    if (cics.file) {
      relations.push({
        type: "cics-file",
        from: canonicalId,
        to: cics.file,
        loc: cics.loc,
        metadata: { command: cics.command },
      });
    }
  }
  for (const access of cobolModel.fileAccesses) {
    relations.push({
      type: "file-access",
      from: canonicalId,
      to: access.file,
      loc: access.loc,
      metadata: {
        operation: access.operation,
        mode: access.mode,
        recordName: access.recordName,
      },
    });
  }

  return { units, procedures, symbols, relations, diagnostics: [] };
}

// ---------------------------------------------------------------------------
// Variable tracer adapter
// ---------------------------------------------------------------------------

function adaptVariableRefs(
  refs: ReturnType<typeof cobolTraceVariable>
): VariableReference[] {
  return refs.map((r) => ({
    variable: r.variable,
    qualifiedName: r.qualifiedName,
    procedure: r.paragraph,
    section: r.section,
    line: r.line,
    access: r.access,
    statement: r.statement,
    verb: r.verb,
  }));
}

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

export const cobolPlugin: CodeAnalysisPlugin = {
  id: "cobol",
  languages: ["COBOL"],
  extensions: [".cbl", ".cob", ".cpy"],

  parse(source: string, filename: string): CobolAST {
    return parse(source, filename);
  },

  normalize(ast: unknown): NormalizedCodeModel {
    const cobolAst = ast as CobolAST;
    const cobolModel = extractModel(cobolAst);
    const normalized = cobolToNormalized(cobolModel);
    for (const edge of extractDataflowEdges(cobolAst)) {
      normalized.relations.push({
        type: "dataflow",
        from: edge.from,
        to: edge.to,
        loc: { line: edge.line, column: 0 },
        metadata: { via: edge.via, procedure: edge.procedure, section: edge.section },
      });
    }
    for (const edge of extractCallEdges(cobolAst)) {
      normalized.relations.push({
        type: "call-param",
        from: edge.from,
        to: edge.to,
        loc: { line: edge.line, column: 0 },
        metadata: { via: edge.via, procedure: edge.procedure, section: edge.section },
      });
    }
    return normalized;
  },

  generateWikiPages(
    model: NormalizedCodeModel,
    sourceFile: string,
    ast?: unknown,
  ): Array<{ path: string; content: string }> {
    // Wiki generation uses the richer COBOL-specific model for full-fidelity
    // pages (data item tables, PIC clauses, etc.) that the normalized model
    // intentionally does not carry.
    const cobolAst = ast as CobolAST;
    const cobolModel = extractModel(cobolAst);
    const summary = generateSummary(cobolModel);

    if (isCopybook(sourceFile)) {
      return [generateCopybookPage(cobolModel)];
    }
    return [generateProgramPage(cobolModel, summary, model)];
  },

  traceVariable(ast: unknown, variable: string): VariableReference[] {
    return adaptVariableRefs(cobolTraceVariable(ast as CobolAST, variable));
  },

  extractLanguageModel(ast: unknown): CobolCodeModel {
    return extractModel(ast as CobolAST);
  },

  rebuildAggregatePages(parsedDir: string): Array<{ path: string; content: string }> {
    if (!existsSync(parsedDir)) return [];
    const models = loadCobolModels(parsedDir);
    if (models.length === 0) return [];
    return [generateCallGraphPage(models)];
  },

  buildKnowledgeGraph(parsedDir: string): {
    serialized: SerializedGraph;
    wikiPages: Array<{ path: string; content: string }>;
  } | null {
    if (!existsSync(parsedDir)) return null;
    const models = loadCobolModels(parsedDir);
    if (models.length === 0) return null;

    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, models);
    const graph = builder.build();
    const serialized = serializeGraph(graph);

    // Generate system-map wiki page
    const wikiPages: Array<{ path: string; content: string }> = [];
    wikiPages.push(generateSystemMapPage(serialized));

    return { serialized, wikiPages };
  },

  buildDerivedArtifacts(parsedDir: string): {
    artifacts: Array<{ path: string; content: string }>;
    wikiPages: Array<{ path: string; content: string }>;
    staleArtifacts?: string[];
    staleWikiPages?: string[];
  } | null {
    if (!existsSync(parsedDir)) {
      return {
        artifacts: [],
        wikiPages: [],
        staleArtifacts: ["field-lineage.json"],
        staleWikiPages: ["cobol/field-lineage.md"],
      };
    }
    const models = loadCobolModels(parsedDir);
    if (models.length === 0) {
      return {
        artifacts: [],
        wikiPages: [],
        staleArtifacts: ["field-lineage.json"],
        staleWikiPages: ["cobol/field-lineage.md"],
      };
    }

    const copybookLineage = buildFieldLineage(models);
    const callLineage = buildCallBoundLineage(models);
    const db2Lineage = buildDb2TableLineage(models);
    const lineage = combineFieldLineage(copybookLineage, {
      callBound: callLineage,
      db2: db2Lineage,
    });
    if (!lineage) {
      return {
        artifacts: [],
        wikiPages: [],
        staleArtifacts: ["field-lineage.json"],
        staleWikiPages: ["cobol/field-lineage.md"],
      };
    }

    return {
      artifacts: [{
        path: "field-lineage.json",
        content: JSON.stringify(lineage, null, 2),
      }],
      wikiPages: [generateFieldLineagePage(lineage)],
      staleArtifacts: ["field-lineage.json"],
      staleWikiPages: ["cobol/field-lineage.md"],
    };
  },
};

// ---------------------------------------------------------------------------
// System map wiki page — generated from the knowledge graph
// ---------------------------------------------------------------------------

function generateSystemMapPage(graph: SerializedGraph): { path: string; content: string } {
  const lines: string[] = [];

  // Frontmatter
  lines.push("---");
  lines.push('title: "COBOL System Map"');
  lines.push("type: synthesis");
  lines.push("tags: [cobol, system-map, knowledge-graph]");
  const sourceFiles = graph.nodes
    .filter((n) => n.sourceFile)
    .map((n) => `"raw/${n.sourceFile}"`);
  lines.push(`sources: [${sourceFiles.join(", ")}]`);
  lines.push("---");
  lines.push("");

  // Summary
  const resolved = graph.nodes.filter((n) => n.resolved);
  const unresolved = graph.nodes.filter((n) => !n.resolved);
  const byKind = (nodes: typeof graph.nodes) => {
    const m = new Map<string, number>();
    for (const n of nodes) m.set(n.kind, (m.get(n.kind) ?? 0) + 1);
    return m;
  };

  lines.push("## Overview");
  lines.push("");
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total nodes | ${graph.nodes.length} |`);
  lines.push(`| Resolved (source-backed) | ${resolved.length} |`);
  lines.push(`| Unresolved (external references) | ${unresolved.length} |`);
  lines.push(`| Edges | ${graph.edges.length} |`);
  lines.push(`| Diagnostics | ${graph.diagnostics.length} |`);
  lines.push("");

  // Nodes by kind
  const kindCounts = byKind(graph.nodes);
  lines.push("## Nodes by Kind");
  lines.push("");
  lines.push("| Kind | Total | Resolved | Unresolved |");
  lines.push("|------|-------|----------|------------|");
  for (const kind of ["Program", "Copybook", "Dataset", "Job", "Step"]) {
    const total = kindCounts.get(kind) ?? 0;
    if (total === 0) continue;
    const res = graph.nodes.filter((n) => n.kind === kind && n.resolved).length;
    lines.push(`| ${kind} | ${total} | ${res} | ${total - res} |`);
  }
  lines.push("");

  // Programs table
  const programs = graph.nodes.filter((n) => n.kind === "Program");
  if (programs.length > 0) {
    lines.push("## Programs");
    lines.push("");
    lines.push("| Program | Source | Calls | Copies | Datasets | Status |");
    lines.push("|---------|--------|-------|--------|----------|--------|");
    for (const p of programs) {
      const label = displayLabel(p.id);
      const calls = graph.edges.filter((e) => e.from === p.id && e.kind === "CALLS").length;
      const copies = graph.edges.filter((e) => e.from === p.id && e.kind === "COPIES").length;
      const datasets = graph.edges.filter((e) => e.from === p.id && e.kind === "READS_WRITES").length;
      const status = p.resolved ? "✅ resolved" : "⚠️ unresolved";
      const source = p.sourceFile ?? "—";
      lines.push(`| ${label} | ${source} | ${calls} | ${copies} | ${datasets} | ${status} |`);
    }
    lines.push("");
  }

  // Copybooks table
  const copybooks = graph.nodes.filter((n) => n.kind === "Copybook");
  if (copybooks.length > 0) {
    lines.push("## Copybooks");
    lines.push("");
    lines.push("| Copybook | Used by | Status |");
    lines.push("|----------|---------|--------|");
    for (const c of copybooks) {
      const label = displayLabel(c.id);
      const usedBy = graph.edges
        .filter((e) => e.to === c.id && e.kind === "COPIES")
        .map((e) => displayLabel(e.from));
      const status = c.resolved ? "✅ resolved" : "⚠️ unresolved";
      lines.push(`| ${label} | ${usedBy.join(", ") || "—"} | ${status} |`);
    }
    lines.push("");
  }

  // Datasets table
  const datasets = graph.nodes.filter((n) => n.kind === "Dataset");
  if (datasets.length > 0) {
    lines.push("## Datasets");
    lines.push("");
    lines.push("| Dataset | Accessed by | Status |");
    lines.push("|---------|-------------|--------|");
    for (const d of datasets) {
      const label = displayLabel(d.id);
      const accessedBy = graph.edges
        .filter((e) => e.to === d.id && e.kind === "READS_WRITES")
        .map((e) => displayLabel(e.from));
      const status = d.resolved ? "✅ resolved" : "⚠️ unresolved";
      lines.push(`| ${label} | ${accessedBy.join(", ") || "—"} | ${status} |`);
    }
    lines.push("");
  }

  // Confidence distribution
  const confCounts = new Map<string, number>();
  for (const e of graph.edges) {
    confCounts.set(e.confidence, (confCounts.get(e.confidence) ?? 0) + 1);
  }
  if (graph.edges.length > 0) {
    lines.push("## Edge Confidence");
    lines.push("");
    lines.push("| Confidence | Count |");
    lines.push("|------------|-------|");
    for (const level of ["deterministic", "inferred-high", "inferred-low"]) {
      const count = confCounts.get(level) ?? 0;
      if (count > 0) lines.push(`| ${level} | ${count} |`);
    }
    lines.push("");
  }

  // Diagnostics
  if (graph.diagnostics.length > 0) {
    lines.push("## Diagnostics");
    lines.push("");
    for (const d of graph.diagnostics) {
      const loc = d.sourceFile ? ` (${d.sourceFile}${d.line ? `:${d.line}` : ""})` : "";
      lines.push(`- **${d.severity}**: ${d.message}${loc}`);
    }
    lines.push("");
  }

  return {
    path: "cobol/system-map.md",
    content: lines.join("\n"),
  };
}
