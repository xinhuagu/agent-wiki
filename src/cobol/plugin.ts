/**
 * COBOL code-analysis plugin — ties together lexer, parser, extractors,
 * variable tracer, and wiki generator behind a unified interface.
 */

import { parse } from "./parser.js";
import { extractModel, generateSummary } from "./extractors.js";
import { traceVariable } from "./variable-tracer.js";
import { generateProgramPage, generateCopybookPage } from "./wiki-gen.js";
import type { CobolAST } from "./types.js";
import type { CobolCodeModel, CodeSummary } from "./extractors.js";
import type { VariableReference } from "./variable-tracer.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface CodeParseResult {
  ast: CobolAST;
  model: CobolCodeModel;
  summary: CodeSummary;
  wikiPages: { path: string; content: string }[];
  variableTrace?: VariableReference[];
}

const COBOL_EXTENSIONS = new Set([".cbl", ".cob", ".cpy"]);

export function isCobolFile(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return COBOL_EXTENSIONS.has(ext);
}

export function isCopybook(filename: string): boolean {
  return filename.toLowerCase().endsWith(".cpy");
}

/**
 * Parse a COBOL source file and produce all artifacts.
 */
export function parseCobol(
  source: string,
  filename: string,
  traceVar?: string,
): CodeParseResult {
  const ast = parse(source, filename);
  const model = extractModel(ast);
  const summary = generateSummary(model);

  // Generate wiki pages
  const wikiPages: { path: string; content: string }[] = [];
  if (isCopybook(filename)) {
    wikiPages.push(generateCopybookPage(model));
  } else {
    wikiPages.push(generateProgramPage(model, summary));
  }

  // Optional variable trace
  let variableTrace: VariableReference[] | undefined;
  if (traceVar) {
    variableTrace = traceVariable(ast, traceVar);
  }

  return { ast, model, summary, wikiPages, variableTrace };
}
