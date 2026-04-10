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

// ---------------------------------------------------------------------------
// Code model types
// ---------------------------------------------------------------------------

export interface CobolCodeModel {
  programId: string;
  sourceFile: string;
  divisions: { name: string; loc: SourceLocation }[];
  sections: { name: string; division: string; loc: SourceLocation }[];
  paragraphs: { name: string; section: string; loc: SourceLocation }[];
  calls: { target: string; fromParagraph: string; loc: SourceLocation }[];
  performs: { target: string; fromParagraph: string; thru?: string; loc: SourceLocation }[];
  copies: { copybook: string; replacing?: string[]; loc: SourceLocation }[];
  dataItems: DataItemNode[];
  fileDefinitions: { fd: string; recordName?: string; loc: SourceLocation }[];
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
    fileDefinitions: [],
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
