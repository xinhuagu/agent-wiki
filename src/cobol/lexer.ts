/**
 * COBOL lexer — tokenizes fixed-format and free-format COBOL source.
 *
 * Fixed-format layout (cols 1-based):
 *   1-6   sequence number (ignored)
 *   7     indicator: * or / = comment, - = continuation, D = debug
 *   8-11  area A
 *   12-72 area B
 *   73+   identification (ignored)
 *
 * Free-format: no column constraints, comments via *> inline.
 */

import type { Token, TokenType } from "./types.js";

// ---------------------------------------------------------------------------
// Keyword sets
// ---------------------------------------------------------------------------

const DIVISIONS = new Set([
  "IDENTIFICATION", "ID", "ENVIRONMENT", "DATA", "PROCEDURE",
]);

const VERBS = new Set([
  "ACCEPT", "ADD", "ALTER", "CALL", "CANCEL", "CLOSE", "COMPUTE",
  "CONTINUE", "DELETE", "DISPLAY", "DIVIDE", "EVALUATE", "EXIT",
  "GO", "GOBACK", "IF", "INITIALIZE", "INSPECT", "MERGE", "MOVE",
  "MULTIPLY", "OPEN", "PERFORM", "READ", "RELEASE", "RETURN",
  "REWRITE", "SEARCH", "SET", "SORT", "START", "STOP", "STRING",
  "SUBTRACT", "UNSTRING", "WRITE", "EXEC", "END-EXEC",
  "WHEN", "ELSE", "END-IF", "END-EVALUATE", "END-PERFORM",
  "END-CALL", "END-COMPUTE", "END-READ", "END-WRITE",
  "END-STRING", "END-UNSTRING", "END-MULTIPLY", "END-DIVIDE",
  "END-ADD", "END-SUBTRACT", "END-SEARCH", "END-RETURN",
  "END-DELETE", "END-REWRITE", "END-START", "END-ACCEPT",
  "NOT", "THAN", "EQUAL", "GREATER", "LESS", "AND", "OR",
]);

const KEYWORD_MAP: Record<string, TokenType> = {
  "COPY": "COPY",
  "CALL": "CALL",
  "PERFORM": "PERFORM",
  "PROGRAM-ID": "PROGRAM_ID",
  "FD": "FD",
  "SD": "SD",
  "TO": "TO",
  "FROM": "FROM",
  "USING": "USING",
  "GIVING": "GIVING",
  "INTO": "INTO",
  "BY": "BY",
  "THRU": "THRU",
  "THROUGH": "THRU",
  "REPLACING": "REPLACING",
  "OF": "OF",
  "IN": "IN",
  "VALUE": "VALUE",
  "VALUES": "VALUE",
  "REDEFINES": "REDEFINES",
  "OCCURS": "OCCURS",
  "TIMES": "TIMES",
  "USAGE": "USAGE",
  "IS": "IS",
  "FILLER": "FILLER",
  "PIC": "PIC",
  "PICTURE": "PIC",
};

// ---------------------------------------------------------------------------
// Line pre-processing
// ---------------------------------------------------------------------------

interface SourceLine {
  /** 1-based line number in the original file */
  lineNumber: number;
  /** The text content (area A+B for fixed format, full line for free) */
  text: string;
}

function isFixedFormat(lines: string[]): boolean {
  // Heuristic: if ≥60 % of non-blank lines have cols 1-6 as alphanumeric/space
  // (the "sequence area" — COBOL spec allows any character; common mainframe
  // change-control prefixes like "XX0001", "XX0002" mix letters and digits)
  // and col 7 as space or indicator, treat as fixed-format.
  let fixed = 0;
  let total = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    total++;
    if (line.length >= 7) {
      const seq = line.slice(0, 6);
      const ind = line[6];
      const seqOk = /^[A-Za-z0-9 ]{6}$/.test(seq);
      const indOk = " */-dD".includes(ind);
      if (seqOk && indOk) fixed++;
    }
  }
  return total > 0 && fixed / total >= 0.6;
}

function preprocessLines(source: string): SourceLine[] {
  const rawLines = source.split(/\r?\n/);
  const fixed = isFixedFormat(rawLines);
  const result: SourceLine[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const lineNum = i + 1;

    if (fixed) {
      if (raw.length < 7) {
        // Too short — skip
        continue;
      }
      const indicator = raw[6];
      if (indicator === "*" || indicator === "/") {
        // Comment line
        continue;
      }
      if (indicator === "D" || indicator === "d") {
        // Debug line — skip
        continue;
      }
      if (indicator === "-") {
        // Continuation — append to previous line
        const continued = raw.slice(11).trimStart();
        if (result.length > 0) {
          result[result.length - 1].text += continued;
        }
        continue;
      }
      // Normal line: take cols 8-72 (index 7..71)
      const text = raw.length > 72 ? raw.slice(7, 72) : raw.slice(7);
      result.push({ lineNumber: lineNum, text });
    } else {
      // Free format
      // Strip inline comments (*>)
      const commentIdx = raw.indexOf("*>");
      const text = commentIdx >= 0 ? raw.slice(0, commentIdx) : raw;
      if (text.trim().length === 0) continue;
      result.push({ lineNumber: lineNum, text });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export function tokenize(source: string): Token[] {
  const lines = preprocessLines(source);
  const tokens: Token[] = [];

  for (const { lineNumber, text } of lines) {
    let pos = 0;

    while (pos < text.length) {
      // Skip whitespace
      if (/\s/.test(text[pos])) {
        pos++;
        continue;
      }

      const col = pos + 1;

      // Period (sentence terminator)
      if (text[pos] === ".") {
        // Check it's a standalone period (not part of a number like 3.14)
        if (pos + 1 >= text.length || /\s/.test(text[pos + 1])) {
          tokens.push({ type: "PERIOD", value: ".", line: lineNumber, column: col });
          pos++;
          continue;
        }
      }

      // String literal (single or double quoted)
      if (text[pos] === "'" || text[pos] === '"') {
        const quote = text[pos];
        let end = pos + 1;
        while (end < text.length && text[end] !== quote) end++;
        if (end < text.length) end++; // consume closing quote
        const val = text.slice(pos, end);
        tokens.push({ type: "LITERAL", value: val, line: lineNumber, column: col });
        pos = end;
        continue;
      }

      // PIC/PICTURE clause value — must run before numeric handler
      // because PIC strings like 9(5)V99 start with digits.
      if (tokens.length > 0) {
        const prev = tokens[tokens.length - 1];
        if (prev.type === "PIC" || (prev.type === "IS" && tokens.length >= 2 && tokens[tokens.length - 2].type === "PIC")) {
          let end = pos;
          while (end < text.length && !/\s/.test(text[end]) && text[end] !== ".") end++;
          const val = text.slice(pos, end);
          tokens.push({ type: "LITERAL", value: val, line: lineNumber, column: col });
          pos = end;
          continue;
        }
      }

      // Numeric literal or level number
      if (/\d/.test(text[pos]) || (text[pos] === "-" && pos + 1 < text.length && /\d/.test(text[pos + 1]))) {
        let end = pos;
        if (text[end] === "-") end++;
        while (end < text.length && /[\d.]/.test(text[end])) end++;
        const val = text.slice(pos, end);
        // Level numbers: 1-49, 66, 77, 88 — only when purely integer
        const num = parseInt(val, 10);
        if (/^\d{1,2}$/.test(val) && ((num >= 1 && num <= 49) || num === 66 || num === 77 || num === 88)) {
          tokens.push({ type: "LEVEL_NUMBER", value: val, line: lineNumber, column: col });
        } else {
          tokens.push({ type: "NUMERIC", value: val, line: lineNumber, column: col });
        }
        pos = end;
        continue;
      }

      // Word (identifier or keyword)
      if (/[A-Za-z]/.test(text[pos])) {
        let end = pos;
        while (end < text.length && /[A-Za-z0-9\-_]/.test(text[end])) end++;
        const word = text.slice(pos, end);
        const upper = word.toUpperCase();

        // Check for DIVISION keyword following the word
        const rest = text.slice(end).trimStart();

        if (DIVISIONS.has(upper) && /^DIVISION\b/i.test(rest)) {
          tokens.push({ type: "DIVISION", value: upper === "ID" ? "IDENTIFICATION" : upper, line: lineNumber, column: col });
          // Skip the "DIVISION" word
          const divStart = text.indexOf(rest, end);
          pos = divStart + 8; // length of "DIVISION"
          continue;
        }

        if (upper === "SECTION") {
          tokens.push({ type: "SECTION", value: "SECTION", line: lineNumber, column: col });
          pos = end;
          continue;
        }

        // Specific keyword?
        const kwType = KEYWORD_MAP[upper];
        if (kwType) {
          tokens.push({ type: kwType, value: upper, line: lineNumber, column: col });
          pos = end;
          continue;
        }

        // Verb?
        if (VERBS.has(upper)) {
          tokens.push({ type: "VERB", value: upper, line: lineNumber, column: col });
          pos = end;
          continue;
        }

        // Otherwise: identifier
        tokens.push({ type: "IDENTIFIER", value: upper, line: lineNumber, column: col });
        pos = end;
        continue;
      }

      // Operators and special characters — emit as identifiers
      if ("().=<>+-*/,;:".includes(text[pos])) {
        tokens.push({ type: "IDENTIFIER", value: text[pos], line: lineNumber, column: col });
        pos++;
        continue;
      }

      // Unknown character — skip
      pos++;
    }
  }

  tokens.push({ type: "EOF", value: "", line: lines.length > 0 ? lines[lines.length - 1].lineNumber : 0, column: 0 });
  return tokens;
}
