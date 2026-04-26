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
import { traceVariable as cobolTraceVariable } from "./variable-tracer.js";
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
    const cobolModel = extractModel(ast as CobolAST);
    return cobolToNormalized(cobolModel);
  },

  generateWikiPages(
    _model: NormalizedCodeModel,
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
    return [generateProgramPage(cobolModel, summary)];
  },

  traceVariable(ast: unknown, variable: string): VariableReference[] {
    return adaptVariableRefs(cobolTraceVariable(ast as CobolAST, variable));
  },

  extractLanguageModel(ast: unknown): CobolCodeModel {
    return extractModel(ast as CobolAST);
  },

  rebuildAggregatePages(parsedDir: string): Array<{ path: string; content: string }> {
    if (!existsSync(parsedDir)) return [];
    const models: CobolCodeModel[] = [];
    for (const file of readdirSync(parsedDir)) {
      if (!file.endsWith(".model.json")) continue;
      try {
        models.push(JSON.parse(readFileSync(join(parsedDir, file), "utf-8")));
      } catch {
        // Skip malformed files
      }
    }
    if (models.length === 0) return [];
    return [generateCallGraphPage(models)];
  },

  buildKnowledgeGraph(parsedDir: string): {
    serialized: SerializedGraph;
    wikiPages: Array<{ path: string; content: string }>;
  } | null {
    if (!existsSync(parsedDir)) return null;
    const models: CobolCodeModel[] = [];
    for (const file of readdirSync(parsedDir)) {
      if (!file.endsWith(".model.json")) continue;
      try {
        models.push(JSON.parse(readFileSync(join(parsedDir, file), "utf-8")));
      } catch {
        // Skip malformed files
      }
    }
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
