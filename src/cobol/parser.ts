/**
 * COBOL recursive-descent parser.
 *
 * Consumes the token stream produced by the lexer and builds a CobolAST.
 * Scope for v1:
 *  - IDENTIFICATION DIVISION → PROGRAM-ID
 *  - DATA DIVISION → level-number hierarchies, PIC, REDEFINES, OCCURS, FD/SD
 *  - PROCEDURE DIVISION → sections, paragraphs, statements (verb + operands)
 *  - ENVIRONMENT DIVISION → section boundaries only
 */

import type {
  CobolAST,
  DataItemNode,
  DivisionName,
  DivisionNode,
  FileDefinitionNode,
  ParagraphNode,
  SectionNode,
  SourceLocation,
  StatementNode,
  Token,
  TokenType,
} from "./types.js";
import { tokenize } from "./lexer.js";

// ---------------------------------------------------------------------------
// Parser state
// ---------------------------------------------------------------------------

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  // ---- helpers -----------------------------------------------------------

  private peek(): Token {
    return this.tokens[this.pos] ?? { type: "EOF", value: "", line: 0, column: 0 };
  }

  private advance(): Token {
    const t = this.peek();
    if (t.type !== "EOF") this.pos++;
    return t;
  }

  private expect(type: TokenType): Token {
    const t = this.advance();
    if (t.type !== type) {
      throw new Error(`Expected ${type} but got ${t.type} ("${t.value}") at line ${t.line}:${t.column}`);
    }
    return t;
  }

  private match(type: TokenType): Token | null {
    if (this.peek().type === type) return this.advance();
    return null;
  }

  private loc(token: Token): SourceLocation {
    return { line: token.line, column: token.column };
  }

  private atEnd(): boolean {
    return this.peek().type === "EOF";
  }

  /** Consume a period if present; don't fail if missing. */
  private consumePeriod(): void {
    this.match("PERIOD");
  }

  /** Skip tokens until we hit one of the given types (does not consume it). */
  private skipUntil(...types: TokenType[]): void {
    const set = new Set(types);
    while (!this.atEnd() && !set.has(this.peek().type)) {
      this.advance();
    }
  }

  // ---- program -----------------------------------------------------------

  parseProgram(sourceFile: string): CobolAST {
    const divisions: DivisionNode[] = [];
    let programId = "";

    // Check if the source has any DIVISION tokens at all.
    // Standalone copybooks (.cpy) are typically just data item declarations
    // with no DIVISION headers — handle them with a synthetic DATA DIVISION.
    const hasDivisions = this.tokens.some((t) => t.type === "DIVISION");

    if (!hasDivisions) {
      // Treat entire token stream as data items in a synthetic DATA DIVISION
      const dataItems = this.parseDataItems();
      if (dataItems.length > 0) {
        const section: SectionNode = {
          type: "Section",
          name: "WORKING-STORAGE",
          paragraphs: [],
          dataItems,
          fileDefinitions: [],
          loc: dataItems[0].loc,
        };
        divisions.push({
          type: "Division",
          name: "DATA",
          sections: [section],
          loc: dataItems[0].loc,
        });
      }
    } else {
      while (!this.atEnd()) {
        if (this.peek().type === "DIVISION") {
          const div = this.parseDivision();
          divisions.push(div);
          if (div.name === "IDENTIFICATION") {
            programId = this.extractProgramId(div);
          }
        } else {
          this.advance();
        }
      }
    }

    return { type: "Program", programId, divisions, sourceFile };
  }

  // ---- divisions ---------------------------------------------------------

  private parseDivision(): DivisionNode {
    const start = this.peek();
    const name = this.advance().value as DivisionName;

    const sections: SectionNode[] = [];

    if (name === "PROCEDURE") {
      // PROCEDURE DIVISION [USING ...].
      // Do NOT consume period before skipProcedureUsing — the period
      // after "PROCEDURE DIVISION" hasn't been consumed yet.
      this.skipProcedureUsing();
      this.consumePeriod();
      sections.push(...this.parseProcedureDivision());
    } else {
      this.consumePeriod();
      if (name === "IDENTIFICATION" || name === "ENVIRONMENT") {
        const items = this.parseIdentOrEnvDivision();
        if (items.length > 0) {
          sections.push(...items);
        }
      } else if (name === "DATA") {
        sections.push(...this.parseDataDivision());
      }
    }

    return { type: "Division", name, sections, loc: this.loc(start) };
  }

  private skipProcedureUsing(): void {
    // PROCEDURE DIVISION [USING ...].
    while (!this.atEnd() && this.peek().type !== "PERIOD" && this.peek().type !== "DIVISION") {
      this.advance();
    }
  }

  // ---- IDENTIFICATION / ENVIRONMENT DIVISION -----------------------------

  private parseIdentOrEnvDivision(): SectionNode[] {
    const sections: SectionNode[] = [];
    let currentSection: SectionNode | null = null;

    while (!this.atEnd() && this.peek().type !== "DIVISION") {
      const t = this.peek();

      if (t.type === "SECTION") {
        this.advance();
        this.consumePeriod();
        continue;
      }

      // Detect section headers: WORD SECTION.
      if (t.type === "IDENTIFIER" || t.type === "PROGRAM_ID") {
        const nextIdx = this.pos + 1;
        if (nextIdx < this.tokens.length && this.tokens[nextIdx].type === "SECTION") {
          const nameToken = this.advance();
          this.advance(); // SECTION
          this.consumePeriod();
          currentSection = {
            type: "Section",
            name: nameToken.value,
            paragraphs: [],
            dataItems: [],
            fileDefinitions: [],
            loc: this.loc(nameToken),
          };
          sections.push(currentSection);
          continue;
        }

        // PROGRAM-ID. <name>.
        if (t.type === "PROGRAM_ID") {
          this.advance();
          this.consumePeriod();
          // The program name follows
          if (!this.atEnd() && this.peek().type !== "PERIOD" && this.peek().type !== "DIVISION") {
            this.advance(); // consume program name
          }
          this.consumePeriod();
          continue;
        }
      }

      this.advance();
    }

    return sections;
  }

  // ---- DATA DIVISION -----------------------------------------------------

  private parseDataDivision(): SectionNode[] {
    const sections: SectionNode[] = [];

    while (!this.atEnd() && this.peek().type !== "DIVISION") {
      const t = this.peek();

      // Detect section headers: e.g. FILE SECTION. / WORKING-STORAGE SECTION.
      if ((t.type === "IDENTIFIER" || t.type === "FD" || t.type === "SD") && this.lookAheadSection()) {
        const nameToken = this.advance();
        this.advance(); // SECTION
        this.consumePeriod();
        const section = this.parseDataSection(nameToken.value, this.loc(nameToken));
        sections.push(section);
        continue;
      }

      // FD/SD at section level (within FILE SECTION)
      if (t.type === "FD" || t.type === "SD") {
        // This happens when there's no explicit section header
        // or we're already inside FILE SECTION
        break;
      }

      // Level numbers at top level (outside any explicit section)
      if (t.type === "LEVEL_NUMBER") {
        const section: SectionNode = {
          type: "Section",
          name: "WORKING-STORAGE",
          paragraphs: [],
          dataItems: this.parseDataItems(),
          fileDefinitions: [],
          loc: this.loc(t),
        };
        sections.push(section);
        continue;
      }

      this.advance();
    }

    return sections;
  }

  private lookAheadSection(): boolean {
    const next = this.pos + 1;
    return next < this.tokens.length && this.tokens[next].type === "SECTION";
  }

  private parseDataSection(name: string, loc: SourceLocation): SectionNode {
    const dataItems: DataItemNode[] = [];
    const fileDefinitions: FileDefinitionNode[] = [];

    while (!this.atEnd() && this.peek().type !== "DIVISION") {
      const t = this.peek();

      // Another section starting?
      if ((t.type === "IDENTIFIER") && this.lookAheadSection()) break;

      // FD / SD
      if (t.type === "FD" || t.type === "SD") {
        fileDefinitions.push(this.parseFileDefinition());
        continue;
      }

      // Level number
      if (t.type === "LEVEL_NUMBER") {
        dataItems.push(...this.parseDataItems());
        continue;
      }

      this.advance();
    }

    return { type: "Section", name, paragraphs: [], dataItems, fileDefinitions, loc };
  }

  // ---- File definitions (FD/SD) ------------------------------------------

  private parseFileDefinition(): FileDefinitionNode {
    const start = this.advance(); // FD or SD
    let fdName = "";
    if (!this.atEnd() && this.peek().type === "IDENTIFIER") {
      fdName = this.advance().value;
    }
    // Skip rest of FD clause until period
    this.skipUntil("PERIOD", "LEVEL_NUMBER", "DIVISION");
    this.consumePeriod();

    // The record name is the 01-level that follows
    let recordName: string | undefined;
    if (!this.atEnd() && this.peek().type === "LEVEL_NUMBER" && this.peek().value === "01") {
      const nextIdx = this.pos + 1;
      if (nextIdx < this.tokens.length && (this.tokens[nextIdx].type === "IDENTIFIER" || this.tokens[nextIdx].type === "FILLER")) {
        recordName = this.tokens[nextIdx].value;
      }
    }

    return { type: "FileDefinition", fd: fdName, recordName, loc: this.loc(start) };
  }

  // ---- Data items (level-number parsing) ---------------------------------

  private parseDataItems(): DataItemNode[] {
    const items: DataItemNode[] = [];

    while (!this.atEnd() && this.peek().type === "LEVEL_NUMBER") {
      items.push(this.parseOneDataItem());
    }

    return buildDataHierarchy(items);
  }

  private parseOneDataItem(): DataItemNode {
    const start = this.advance(); // LEVEL_NUMBER
    const level = parseInt(start.value, 10);

    let name = "FILLER";
    if (!this.atEnd()) {
      const t = this.peek();
      if (t.type === "IDENTIFIER" || t.type === "FILLER") {
        name = this.advance().value;
      }
    }

    let picture: string | undefined;
    let usage: string | undefined;
    let value: string | undefined;
    let redefines: string | undefined;
    let occurs: number | undefined;

    // Parse clauses until period or next level number
    while (!this.atEnd() && this.peek().type !== "PERIOD" && this.peek().type !== "LEVEL_NUMBER" && this.peek().type !== "DIVISION") {
      const t = this.peek();

      if (t.type === "PIC") {
        this.advance();
        this.match("IS");
        if (!this.atEnd() && this.peek().type === "LITERAL") {
          picture = this.advance().value;
        } else if (!this.atEnd() && this.peek().type === "IDENTIFIER") {
          picture = this.advance().value;
        }
        continue;
      }

      if (t.type === "USAGE") {
        this.advance();
        this.match("IS");
        if (!this.atEnd() && (this.peek().type === "IDENTIFIER" || this.peek().type === "VERB")) {
          usage = this.advance().value;
        }
        continue;
      }

      if (t.type === "VALUE") {
        this.advance();
        this.match("IS");
        if (!this.atEnd() && (this.peek().type === "LITERAL" || this.peek().type === "NUMERIC" || this.peek().type === "IDENTIFIER")) {
          value = this.advance().value;
        }
        continue;
      }

      if (t.type === "REDEFINES") {
        this.advance();
        if (!this.atEnd() && this.peek().type === "IDENTIFIER") {
          redefines = this.advance().value;
        }
        continue;
      }

      if (t.type === "OCCURS") {
        this.advance();
        if (!this.atEnd() && this.peek().type === "NUMERIC") {
          occurs = parseInt(this.advance().value, 10);
        }
        this.match("TIMES");
        continue;
      }

      // Usage shorthands (COMP, COMP-3, BINARY, PACKED-DECIMAL, etc.)
      if (t.type === "IDENTIFIER" && /^(COMP|COMP-\d|COMPUTATIONAL|BINARY|PACKED-DECIMAL|DISPLAY|INDEX)$/i.test(t.value)) {
        usage = this.advance().value;
        continue;
      }

      this.advance();
    }

    this.consumePeriod();

    return {
      type: "DataItem",
      level,
      name,
      picture,
      usage,
      value,
      redefines,
      occurs,
      children: [],
      loc: this.loc(start),
    };
  }

  // ---- PROCEDURE DIVISION ------------------------------------------------

  private parseProcedureDivision(): SectionNode[] {
    const sections: SectionNode[] = [];
    let currentSection: SectionNode | null = null;
    let currentParagraph: ParagraphNode | null = null;

    // Helper to ensure we have a section
    const ensureSection = (tok: Token): SectionNode => {
      if (!currentSection) {
        currentSection = {
          type: "Section",
          name: "(default)",
          paragraphs: [],
          dataItems: [],
          fileDefinitions: [],
          loc: this.loc(tok),
        };
        sections.push(currentSection);
      }
      return currentSection;
    };

    while (!this.atEnd() && this.peek().type !== "DIVISION") {
      const t = this.peek();

      // SECTION header: IDENTIFIER SECTION.
      if (t.type === "IDENTIFIER" && this.lookAheadSection()) {
        const nameToken = this.advance();
        this.advance(); // SECTION
        this.consumePeriod();
        currentSection = {
          type: "Section",
          name: nameToken.value,
          paragraphs: [],
          dataItems: [],
          fileDefinitions: [],
          loc: this.loc(nameToken),
        };
        sections.push(currentSection);
        currentParagraph = null;
        continue;
      }

      // Paragraph header: IDENTIFIER followed by PERIOD (but not SECTION)
      if (t.type === "IDENTIFIER" && this.isParagraphStart()) {
        const nameToken = this.advance();
        this.consumePeriod();
        const sec = ensureSection(nameToken);
        currentParagraph = {
          type: "Paragraph",
          name: nameToken.value,
          statements: [],
          loc: this.loc(nameToken),
        };
        sec.paragraphs.push(currentParagraph);
        continue;
      }

      // Statement (starts with a verb or known keyword)
      if (this.isStatementStart(t)) {
        const stmt = this.parseStatement();
        if (currentParagraph) {
          currentParagraph.statements.push(stmt);
        } else {
          const sec = ensureSection(t);
          if (sec.paragraphs.length === 0) {
            currentParagraph = {
              type: "Paragraph",
              name: "(default)",
              statements: [],
              loc: this.loc(t),
            };
            sec.paragraphs.push(currentParagraph);
          } else {
            currentParagraph = sec.paragraphs[sec.paragraphs.length - 1];
          }
          currentParagraph.statements.push(stmt);
        }
        continue;
      }

      this.advance();
    }

    return sections;
  }

  private isParagraphStart(): boolean {
    // An identifier followed by a period is a paragraph name.
    // But we must not confuse it with an identifier that's part of a statement.
    // Paragraph names appear at the start of a "sentence" and are followed by period.
    const nextIdx = this.pos + 1;
    if (nextIdx >= this.tokens.length) return false;
    const next = this.tokens[nextIdx];
    return next.type === "PERIOD";
  }

  private isStatementStart(t: Token): boolean {
    return t.type === "VERB" || t.type === "CALL" || t.type === "PERFORM" || t.type === "COPY";
  }

  private parseStatement(): StatementNode {
    const start = this.advance(); // verb
    const verb = start.value;
    const operands: string[] = [];
    const rawParts: string[] = [verb];

    // Collect operands until period, next verb, or end
    while (!this.atEnd()) {
      const t = this.peek();
      if (t.type === "PERIOD") {
        this.advance();
        break;
      }
      if (t.type === "DIVISION") break;
      // Next statement start — don't consume
      if (this.isStatementStart(t) && t.line !== start.line) break;
      // END-xxx terminates the current statement
      if (t.type === "VERB" && t.value.startsWith("END-")) {
        rawParts.push(t.value);
        this.advance();
        this.consumePeriod();
        break;
      }

      rawParts.push(t.value);
      if (t.type === "IDENTIFIER" || t.type === "LITERAL" || t.type === "NUMERIC") {
        operands.push(t.value);
      }
      this.advance();
    }

    return {
      type: "Statement",
      verb,
      operands,
      rawText: rawParts.join(" "),
      loc: this.loc(start),
    };
  }

  // ---- extract helpers ---------------------------------------------------

  private extractProgramId(div: DivisionNode): string {
    // Look through the raw tokens we already parsed.
    // The PROGRAM-ID is stored as tokens: PROGRAM_ID PERIOD? IDENTIFIER PERIOD?
    // We need to scan the tokens in the IDENTIFICATION division region.
    for (let i = 0; i < this.tokens.length - 1; i++) {
      if (this.tokens[i].type === "PROGRAM_ID") {
        // Skip period and IS
        let j = i + 1;
        while (j < this.tokens.length && (this.tokens[j].type === "PERIOD" || this.tokens[j].type === "IS")) {
          j++;
        }
        if (j < this.tokens.length && (this.tokens[j].type === "IDENTIFIER" || this.tokens[j].type === "LITERAL")) {
          return this.tokens[j].value;
        }
      }
    }
    return "";
  }
}

// ---------------------------------------------------------------------------
// Data item hierarchy builder
// ---------------------------------------------------------------------------

/**
 * Flat list of data items with level numbers → nested tree.
 * Level 01 items are roots. Higher levels nest under the nearest lower level.
 */
function buildDataHierarchy(flat: DataItemNode[]): DataItemNode[] {
  const roots: DataItemNode[] = [];
  const stack: DataItemNode[] = [];

  for (const item of flat) {
    // Level 66, 77, 88 are special — always top-level siblings
    if (item.level === 66 || item.level === 77 || item.level === 88) {
      if (item.level === 88 && stack.length > 0) {
        // 88-level conditions belong to the immediately preceding item
        stack[stack.length - 1].children.push(item);
      } else {
        roots.push(item);
      }
      continue;
    }

    // Pop stack until we find a parent with a lower level number
    while (stack.length > 0 && stack[stack.length - 1].level >= item.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(item);
    } else {
      stack[stack.length - 1].children.push(item);
    }

    stack.push(item);
  }

  return roots;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parse(source: string, sourceFile: string): CobolAST {
  const tokens = tokenize(source);
  const parser = new Parser(tokens);
  return parser.parseProgram(sourceFile);
}
