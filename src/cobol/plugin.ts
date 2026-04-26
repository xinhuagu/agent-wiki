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
import { resolveCanonicalId, canonicalNodeId } from "./graph.js";
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
};
