/**
 * Code-analysis plugin system — language-agnostic model and plugin registry.
 *
 * The NormalizedCodeModel is the shared representation that all language
 * plugins emit. The core wiki layer consumes only this model, never
 * language-specific ASTs. This keeps COBOL/Java/JCL details out of wiki.ts
 * and server.ts.
 */

// ---------------------------------------------------------------------------
// Normalized code knowledge model (language-agnostic)
// ---------------------------------------------------------------------------

export interface SourceLocation {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

/** A compilation unit, module, program, or class. */
export interface CodeUnit {
  name: string;
  kind: string;  // "program", "class", "module", "copybook", "job", ...
  language: string;
  sourceFile: string;
  loc?: SourceLocation;
}

/** A procedure, function, method, paragraph, or section. */
export interface CodeProcedure {
  name: string;
  kind: string;  // "paragraph", "section", "method", "function", ...
  parentUnit?: string;
  parentProcedure?: string;
  loc: SourceLocation;
}

/** A variable, field, data item, or constant. */
export interface CodeSymbol {
  name: string;
  kind: string;  // "variable", "field", "constant", "parameter", "condition", ...
  dataType?: string;
  parentSymbol?: string;
  loc: SourceLocation;
}

/** A relation between code elements. */
export interface CodeRelation {
  type: string;  // "call", "perform", "include", "import", "extends", "implements", ...
  from: string;
  to: string;
  loc: SourceLocation;
  metadata?: Record<string, unknown>;
}

/** A diagnostic or parser warning. */
export interface CodeDiagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  loc?: SourceLocation;
}

/**
 * The normalized code model shared across all language plugins.
 * Every plugin must map its AST into this structure.
 */
export interface NormalizedCodeModel {
  units: CodeUnit[];
  procedures: CodeProcedure[];
  symbols: CodeSymbol[];
  relations: CodeRelation[];
  diagnostics: CodeDiagnostic[];
}

// ---------------------------------------------------------------------------
// Code summary (derived from NormalizedCodeModel)
// ---------------------------------------------------------------------------

export interface NormalizedCodeSummary {
  unitName: string;
  language: string;
  sourceFile: string;
  unitCount: number;
  procedureCount: number;
  symbolCount: number;
  relationsByType: Record<string, number>;
  diagnosticsByLevel: Record<string, number>;
}

export function summarizeModel(model: NormalizedCodeModel): NormalizedCodeSummary {
  const unit = model.units[0];
  const relationsByType: Record<string, number> = {};
  for (const r of model.relations) {
    relationsByType[r.type] = (relationsByType[r.type] ?? 0) + 1;
  }
  const diagnosticsByLevel: Record<string, number> = {};
  for (const d of model.diagnostics) {
    diagnosticsByLevel[d.severity] = (diagnosticsByLevel[d.severity] ?? 0) + 1;
  }
  return {
    unitName: unit?.name ?? "",
    language: unit?.language ?? "",
    sourceFile: unit?.sourceFile ?? "",
    unitCount: model.units.length,
    procedureCount: model.procedures.length,
    symbolCount: model.symbols.length,
    relationsByType,
    diagnosticsByLevel,
  };
}

// ---------------------------------------------------------------------------
// Variable reference (language-agnostic)
// ---------------------------------------------------------------------------

export type AccessMode = "read" | "write" | "both";

export interface VariableReference {
  variable: string;
  qualifiedName?: string;
  procedure: string;
  section: string;
  line: number;
  access: AccessMode;
  statement: string;
  verb: string;
}

// ---------------------------------------------------------------------------
// Plugin interface
// ---------------------------------------------------------------------------

export interface CodeAnalysisPlugin {
  /** Unique plugin identifier, e.g. "cobol" */
  id: string;
  /** Human-readable language names, e.g. ["COBOL"] */
  languages: string[];
  /** File extensions handled, e.g. [".cbl", ".cob", ".cpy"] */
  extensions: string[];
  /** Parse source into a language-specific AST (opaque to the core). */
  parse(source: string, filename: string): unknown;
  /** Normalize the AST into the shared model. */
  normalize(ast: unknown): NormalizedCodeModel;
  /** Generate wiki page content from the normalized model. */
  generateWikiPages(model: NormalizedCodeModel, sourceFile: string): Array<{ path: string; content: string }>;
  /** Optional: trace variable references. */
  traceVariable?(ast: unknown, variable: string): VariableReference[];
}

// ---------------------------------------------------------------------------
// Plugin registry
// ---------------------------------------------------------------------------

const plugins = new Map<string, CodeAnalysisPlugin>();

export function registerPlugin(plugin: CodeAnalysisPlugin): void {
  plugins.set(plugin.id, plugin);
}

export function getPluginForFile(filename: string): CodeAnalysisPlugin | null {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  for (const plugin of plugins.values()) {
    if (plugin.extensions.includes(ext)) return plugin;
  }
  return null;
}

export function getPlugin(id: string): CodeAnalysisPlugin | null {
  return plugins.get(id) ?? null;
}

export function listPlugins(): CodeAnalysisPlugin[] {
  return [...plugins.values()];
}
