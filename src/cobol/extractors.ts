/**
 * COBOL extractors — AST → normalized code model.
 *
 * Walks the CobolAST and extracts structured relations:
 * program structure, CALL/PERFORM/COPY dependencies, data items, file defs.
 */

import type {
  CobolAST,
  DataItemNode,
  DivisionNode,
  SectionNode,
  SourceLocation,
  StatementNode,
} from "./types.js";
import { extractUsingArgs } from "./variable-tracer.js";

// ---------------------------------------------------------------------------
// Code model types
// ---------------------------------------------------------------------------

export interface CobolCodeModel {
  programId: string;
  sourceFile: string;
  divisions: { name: string; loc: SourceLocation }[];
  sections: { name: string; division: string; loc: SourceLocation }[];
  paragraphs: { name: string; section: string; loc: SourceLocation }[];
  calls: { target: string; fromParagraph: string; usingArgs: string[]; loc: SourceLocation }[];
  performs: { target: string; fromParagraph: string; thru?: string; loc: SourceLocation }[];
  copies: { copybook: string; replacing?: string[]; loc: SourceLocation }[];
  dataItems: DataItemNode[];
  linkageItems: DataItemNode[];
  fileDefinitions: { fd: string; recordName?: string; loc: SourceLocation }[];
  db2References: { operation?: string; tables: string[]; rawText: string; loc: SourceLocation }[];
  cicsReferences: {
    command: string;
    program?: string;
    transaction?: string;
    map?: string;
    file?: string;
    rawText: string;
    loc: SourceLocation;
  }[];
  fileAccesses: {
    file: string;
    operation: "OPEN" | "READ" | "WRITE" | "REWRITE" | "DELETE" | "CLOSE";
    mode?: string;
    recordName?: string;
    rawText: string;
    loc: SourceLocation;
  }[];
}

export interface CodeSummary {
  programId: string;
  sourceFile: string;
  divisionCount: number;
  sectionCount: number;
  paragraphCount: number;
  callTargets: string[];
  performTargets: string[];
  copybooks: string[];
  dataItemCount: number;
  fileDefinitions: string[];
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export function extractModel(ast: CobolAST): CobolCodeModel {
  const model: CobolCodeModel = {
    programId: ast.programId,
    sourceFile: ast.sourceFile,
    divisions: [],
    sections: [],
    paragraphs: [],
    calls: [],
    performs: [],
    copies: [],
    dataItems: [],
    linkageItems: [],
    fileDefinitions: [],
    db2References: [],
    cicsReferences: [],
    fileAccesses: [],
  };

  for (const div of ast.divisions) {
    model.divisions.push({ name: div.name, loc: div.loc });

    for (const sec of div.sections) {
      model.sections.push({ name: sec.name, division: div.name, loc: sec.loc });

      // File definitions
      for (const fd of sec.fileDefinitions) {
        model.fileDefinitions.push({ fd: fd.fd, recordName: fd.recordName, loc: fd.loc });
      }

      // Data items
      if (sec.dataItems.length > 0) {
        model.dataItems.push(...sec.dataItems);
        if (sec.name.toUpperCase() === "LINKAGE") {
          model.linkageItems.push(...sec.dataItems);
        }
      }

      // Paragraphs and statements
      for (const para of sec.paragraphs) {
        model.paragraphs.push({ name: para.name, section: sec.name, loc: para.loc });

        for (const stmt of para.statements) {
          extractStatementRelations(stmt, para.name, model);
        }
      }
    }
  }

  return model;
}

function normalizeOperand(value: string): string {
  return value.replace(/['"]/g, "").toUpperCase();
}

function normalizeSqlRawText(rawText: string): string {
  return rawText
    .toUpperCase()
    .replace(/([A-Z0-9_-])\s*\.\s*([A-Z0-9_-])/g, "$1.$2");
}

export function extractSqlTableNames(rawText: string): string[] {
  const tables = new Set<string>();
  const normalized = normalizeSqlRawText(rawText);
  const patterns = [
    /\bFROM\s+([A-Z0-9][A-Z0-9_.-]*)/g,
    /\bJOIN\s+([A-Z0-9][A-Z0-9_.-]*)/g,
    /\bUPDATE\s+([A-Z0-9][A-Z0-9_.-]*)/g,
    /\bINSERT\s+INTO\s+([A-Z0-9][A-Z0-9_.-]*)/g,
    /\bMERGE\s+INTO\s+([A-Z0-9][A-Z0-9_.-]*)/g,
    /\bDELETE\s+FROM\s+([A-Z0-9][A-Z0-9_.-]*)/g,
  ];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const table = match[1]?.replace(/['"]/g, "");
      if (table) tables.add(table);
    }
  }

  return [...tables].sort((a, b) => a.localeCompare(b));
}

function extractParenArgument(rawText: string, keyword: string): string | undefined {
  const match = rawText.match(new RegExp(`${keyword}\\s*\\(\\s*['"]?([A-Z0-9_.-]+)['"]?\\s*\\)`, "i"));
  return match?.[1]?.replace(/['"]/g, "").toUpperCase();
}

function extractDb2Reference(stmt: StatementNode): { operation?: string; tables: string[]; rawText: string; loc: SourceLocation } | null {
  if (stmt.verb !== "EXEC") return null;
  const rawText = stmt.rawText.toUpperCase();
  if (!rawText.startsWith("EXEC SQL ")) return null;

  const operation = rawText.match(/^EXEC\s+SQL\s+([A-Z-]+)/)?.[1];
  return {
    operation,
    tables: extractSqlTableNames(stmt.rawText),
    rawText: stmt.rawText,
    loc: stmt.loc,
  };
}

function extractCicsReference(
  stmt: StatementNode,
): {
  command: string;
  program?: string;
  transaction?: string;
  map?: string;
  file?: string;
  rawText: string;
  loc: SourceLocation;
} | null {
  if (stmt.verb !== "EXEC") return null;
  const rawText = stmt.rawText.toUpperCase();
  if (!rawText.startsWith("EXEC CICS ")) return null;

  const command = rawText.match(/^EXEC\s+CICS\s+([A-Z-]+)/)?.[1] ?? "UNKNOWN";
  return {
    command,
    program: extractParenArgument(stmt.rawText, "PROGRAM"),
    transaction: extractParenArgument(stmt.rawText, "TRANSID") ?? extractParenArgument(stmt.rawText, "TRANSACTION"),
    map: extractParenArgument(stmt.rawText, "MAP"),
    file: extractParenArgument(stmt.rawText, "FILE"),
    rawText: stmt.rawText,
    loc: stmt.loc,
  };
}

function inferFileAccesses(
  stmt: StatementNode,
  model: CobolCodeModel,
): Array<{
  file: string;
  operation: "OPEN" | "READ" | "WRITE" | "REWRITE" | "DELETE" | "CLOSE";
  mode?: string;
  recordName?: string;
  rawText: string;
  loc: SourceLocation;
}> {
  const verb = stmt.verb as "OPEN" | "READ" | "WRITE" | "REWRITE" | "DELETE" | "CLOSE";
  if (!["OPEN", "READ", "WRITE", "REWRITE", "DELETE", "CLOSE"].includes(verb)) return [];

  const knownFiles = new Set(model.fileDefinitions.map((fd) => fd.fd.toUpperCase()));
  const fileByRecord = new Map(
    model.fileDefinitions
      .filter((fd) => fd.recordName)
      .map((fd) => [fd.recordName!.toUpperCase(), fd.fd.toUpperCase()])
  );
  const operands = stmt.operands.map(normalizeOperand);

  if (verb === "OPEN") {
    const modes = new Set(["INPUT", "OUTPUT", "I-O", "EXTEND"]);
    const clauseKeywords = new Set([
      "WITH",
      "NO",
      "REWIND",
      "LOCK",
      "SHARING",
      "REVERSED",
    ]);
    const accesses: Array<{
      file: string;
      operation: "OPEN";
      mode?: string;
      recordName?: string;
      rawText: string;
      loc: SourceLocation;
    }> = [];
    let currentMode: string | undefined;
    let capturedForMode = false;
    for (const operand of operands) {
      if (modes.has(operand)) {
        currentMode = operand;
        capturedForMode = false;
        continue;
      }
      if (knownFiles.size > 0) {
        if (!knownFiles.has(operand)) continue;
      } else {
        if (!currentMode || capturedForMode || clauseKeywords.has(operand)) continue;
        capturedForMode = true;
      }
      accesses.push({
        file: operand,
        operation: "OPEN",
        mode: currentMode,
        rawText: stmt.rawText,
        loc: stmt.loc,
      });
    }
    return accesses;
  }

  if (verb === "CLOSE") {
    return operands
      .filter((operand) => knownFiles.size === 0 || knownFiles.has(operand))
      .map((file) => ({
        file,
        operation: "CLOSE" as const,
        rawText: stmt.rawText,
        loc: stmt.loc,
      }));
  }

  if (verb === "READ") {
    const file = operands.find((operand) => knownFiles.has(operand)) ?? operands[0];
    if (!file) return [];
    return [{
      file,
      operation: "READ",
      rawText: stmt.rawText,
      loc: stmt.loc,
    }];
  }

  const recordName = operands[0];
  const file = (recordName && fileByRecord.get(recordName))
    ?? operands.find((operand) => knownFiles.has(operand));
  if (!file) return [];
  return [{
    file,
    operation: verb,
    recordName,
    rawText: stmt.rawText,
    loc: stmt.loc,
  }];
}

function extractStatementRelations(
  stmt: StatementNode,
  paragraph: string,
  model: CobolCodeModel,
): void {
  const verb = stmt.verb;

  if (verb === "CALL") {
    // CALL "PROGRAM" or CALL identifier
    const target = stmt.operands[0];
    if (target) {
      model.calls.push({
        target: target.replace(/['"]/g, ""),
        fromParagraph: paragraph,
        usingArgs: extractUsingArgs(stmt.rawText),
        loc: stmt.loc,
      });
    }
  }

  if (verb === "PERFORM") {
    // PERFORM paragraph-name [THRU paragraph-name]
    const target = stmt.operands[0];
    if (target) {
      let thru: string | undefined;
      const thruIdx = stmt.rawText.toUpperCase().indexOf(" THRU ");
      const throughIdx = stmt.rawText.toUpperCase().indexOf(" THROUGH ");
      if (thruIdx >= 0 || throughIdx >= 0) {
        // Find the operand after THRU
        const ops = stmt.operands;
        for (let i = 0; i < ops.length - 1; i++) {
          if (ops[i] === target && i + 1 < ops.length) {
            thru = ops[i + 1];
            break;
          }
        }
      }
      model.performs.push({
        target,
        fromParagraph: paragraph,
        thru,
        loc: stmt.loc,
      });
    }
  }

  if (verb === "COPY") {
    // COPY copybook-name [REPLACING ...]
    const copybook = stmt.operands[0];
    if (copybook) {
      const replacing: string[] = [];
      const raw = stmt.rawText.toUpperCase();
      if (raw.includes("REPLACING")) {
        // Collect replacement pairs from operands after REPLACING
        const replIdx = stmt.operands.indexOf("REPLACING");
        if (replIdx >= 0) {
          for (let i = replIdx + 1; i < stmt.operands.length; i++) {
            replacing.push(stmt.operands[i]);
          }
        }
      }
      model.copies.push({
        copybook: copybook.replace(/['"]/g, ""),
        replacing: replacing.length > 0 ? replacing : undefined,
        loc: stmt.loc,
      });
    }
  }

  const db2Ref = extractDb2Reference(stmt);
  if (db2Ref) {
    model.db2References.push(db2Ref);
  }

  const cicsRef = extractCicsReference(stmt);
  if (cicsRef) {
    model.cicsReferences.push(cicsRef);
  }

  const fileAccesses = inferFileAccesses(stmt, model);
  if (fileAccesses.length > 0) {
    model.fileAccesses.push(...fileAccesses);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export function generateSummary(model: CobolCodeModel): CodeSummary {
  const countDataItems = (items: DataItemNode[]): number => {
    let count = 0;
    for (const item of items) {
      count++;
      count += countDataItems(item.children);
    }
    return count;
  };

  return {
    programId: model.programId,
    sourceFile: model.sourceFile,
    divisionCount: model.divisions.length,
    sectionCount: model.sections.length,
    paragraphCount: model.paragraphs.length,
    callTargets: [...new Set(model.calls.map((c) => c.target))],
    performTargets: [...new Set(model.performs.map((p) => p.target))],
    copybooks: [...new Set(model.copies.map((c) => c.copybook))],
    dataItemCount: countDataItems(model.dataItems),
    fileDefinitions: model.fileDefinitions.map((f) => f.fd),
  };
}
