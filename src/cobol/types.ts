/**
 * COBOL AST type definitions.
 *
 * These types represent the Abstract Syntax Tree produced by the COBOL parser.
 * They are language-specific; the normalized code model (shared across languages)
 * lives in ../code-analysis.ts.
 */

// ---------------------------------------------------------------------------
// Source location
// ---------------------------------------------------------------------------

export interface SourceLocation {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

// ---------------------------------------------------------------------------
// Top-level program
// ---------------------------------------------------------------------------

export interface CobolAST {
  type: "Program";
  programId: string;
  divisions: DivisionNode[];
  sourceFile: string;
}

// ---------------------------------------------------------------------------
// Divisions
// ---------------------------------------------------------------------------

export type DivisionName =
  | "IDENTIFICATION"
  | "ENVIRONMENT"
  | "DATA"
  | "PROCEDURE";

export interface DivisionNode {
  type: "Division";
  name: DivisionName;
  sections: SectionNode[];
  loc: SourceLocation;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface SectionNode {
  type: "Section";
  name: string;
  paragraphs: ParagraphNode[];
  dataItems: DataItemNode[];
  fileDefinitions: FileDefinitionNode[];
  loc: SourceLocation;
}

// ---------------------------------------------------------------------------
// Paragraphs (PROCEDURE DIVISION)
// ---------------------------------------------------------------------------

export interface ParagraphNode {
  type: "Paragraph";
  name: string;
  statements: StatementNode[];
  loc: SourceLocation;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export interface StatementNode {
  type: "Statement";
  verb: string;
  operands: string[];
  rawText: string;
  loc: SourceLocation;
}

// ---------------------------------------------------------------------------
// Data items (DATA DIVISION)
// ---------------------------------------------------------------------------

export interface DataItemNode {
  type: "DataItem";
  level: number;
  name: string;
  picture?: string;
  usage?: string;
  value?: string;
  redefines?: string;
  occurs?: number;
  children: DataItemNode[];
  loc: SourceLocation;
}

// ---------------------------------------------------------------------------
// File definitions (FILE SECTION)
// ---------------------------------------------------------------------------

export interface FileDefinitionNode {
  type: "FileDefinition";
  fd: string;
  recordName?: string;
  loc: SourceLocation;
}

// ---------------------------------------------------------------------------
// Token (lexer output)
// ---------------------------------------------------------------------------

export type TokenType =
  | "DIVISION"
  | "SECTION"
  | "PARAGRAPH_NAME"
  | "LEVEL_NUMBER"
  | "VERB"
  | "IDENTIFIER"
  | "LITERAL"
  | "NUMERIC"
  | "PIC"
  | "PERIOD"
  | "KEYWORD"
  | "COPY"
  | "CALL"
  | "PERFORM"
  | "PROGRAM_ID"
  | "FD"
  | "SD"
  | "TO"
  | "FROM"
  | "USING"
  | "GIVING"
  | "INTO"
  | "BY"
  | "THRU"
  | "REPLACING"
  | "OF"
  | "IN"
  | "VALUE"
  | "REDEFINES"
  | "OCCURS"
  | "TIMES"
  | "USAGE"
  | "IS"
  | "FILLER"
  | "EOF";

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}
