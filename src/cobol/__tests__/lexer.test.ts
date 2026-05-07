import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { tokenize } from "../lexer.js";

const FIXTURES = resolve(process.cwd(), "src/cobol/__tests__/fixtures");
const fixture = (name: string) => readFileSync(resolve(FIXTURES, name), "utf-8");

describe("COBOL lexer", () => {
  it("tokenizes a minimal HELLO program", () => {
    const tokens = tokenize(fixture("HELLO.cbl"));
    const types = tokens.map((t) => t.type);

    expect(types).toContain("DIVISION");
    expect(types).toContain("PROGRAM_ID");
    expect(types).toContain("SECTION");
    expect(types).toContain("LEVEL_NUMBER");
    expect(types).toContain("PIC");
    expect(types).toContain("VERB"); // MOVE, DISPLAY, STOP, STRING
    expect(types[types.length - 1]).toBe("EOF");
  });

  it("identifies PROGRAM-ID token", () => {
    const tokens = tokenize(fixture("HELLO.cbl"));
    const pid = tokens.find((t) => t.type === "PROGRAM_ID");
    expect(pid).toBeDefined();
    expect(pid!.value).toBe("PROGRAM-ID");
  });

  it("tokenizes DIVISION headers", () => {
    const tokens = tokenize(fixture("PAYROLL.cbl"));
    const divs = tokens.filter((t) => t.type === "DIVISION");
    const names = divs.map((t) => t.value);
    expect(names).toEqual(["IDENTIFICATION", "ENVIRONMENT", "DATA", "PROCEDURE"]);
  });

  it("preserves line numbers", () => {
    const tokens = tokenize(fixture("HELLO.cbl"));
    const pid = tokens.find((t) => t.type === "PROGRAM_ID");
    expect(pid).toBeDefined();
    expect(pid!.line).toBe(2);
  });

  it("handles PIC clauses", () => {
    const tokens = tokenize(fixture("HELLO.cbl"));
    const picIdx = tokens.findIndex((t) => t.type === "PIC");
    expect(picIdx).toBeGreaterThan(-1);
    // The token after PIC should be the picture string
    const picValue = tokens[picIdx + 1];
    expect(picValue.type).toBe("LITERAL");
    expect(picValue.value).toMatch(/X\(30\)/i);
  });

  it("recognizes CALL and PERFORM keywords", () => {
    const tokens = tokenize(fixture("PAYROLL.cbl"));
    const calls = tokens.filter((t) => t.type === "CALL");
    const performs = tokens.filter((t) => t.type === "PERFORM");
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(performs.length).toBeGreaterThanOrEqual(2);
  });

  it("recognizes FD token", () => {
    const tokens = tokenize(fixture("PAYROLL.cbl"));
    const fds = tokens.filter((t) => t.type === "FD");
    expect(fds.length).toBe(1);
    expect(fds[0].value).toBe("FD");
  });

  it("tokenizes a copybook (data items only)", () => {
    const tokens = tokenize(fixture("DATE-UTILS.cpy"));
    const levels = tokens.filter((t) => t.type === "LEVEL_NUMBER");
    expect(levels.length).toBeGreaterThanOrEqual(5);
  });

  it("does not misclassify truly free-format COBOL (code starts at col 1) as fixed-format", () => {
    // Free-format keeps code at col 1. Even though "IDENTI", "PROGRA", "PROCED"
    // pass the alphanumeric seq-area check, col 7 is a real letter (not in the
    // indicator set " */-dD"), so the heuristic must reject those lines.
    const source = [
      "IDENTIFICATION DIVISION.",
      "PROGRAM-ID. FREEFMT.",
      "PROCEDURE DIVISION.",
      "A000-MAIN SECTION.",
      "A100.",
      "    MOVE 1 TO X.",
      "    STOP RUN.",
    ].join("\n");
    const tokens = tokenize(source);
    const values = tokens.map((t) => t.value);
    // If misclassified as fixed-format, slice(7,) would drop the first 7 chars,
    // losing the verbs entirely. Asserting the verbs survive proves the file
    // stayed free-format.
    expect(values).toContain("IDENTIFICATION");
    expect(values).toContain("PROGRAM-ID");
    expect(values).toContain("MOVE");
    expect(values).toContain("STOP");
  });

  it("treats lines with alphabetic sequence-area prefixes as fixed-format and skips comment indicators", () => {
    // Real-world mainframe pattern: change-control IDs like XX0001 / XX0002
    // occupy cols 1-6 instead of pure digits. The * at col 7 marks the line
    // as a comment and should be stripped, not tokenized.
    const source = [
      "XX0001*    EXEC SQL                                              ",
      "XX0001*       OPEN C-T51                                      ",
      "XX0001*    END-EXEC                                              ",
      "XX0002     EXEC SQL                                              ",
      "XX0002        SELECT NAME FROM CUSTOMERS                         ",
      "XX0002     END-EXEC                                              ",
    ].join("\n");
    const tokens = tokenize(source);
    const values = tokens.map((t) => t.value);
    // Comment-prefixed lines (XX0001*) must be stripped entirely.
    expect(values).not.toContain("XX0001");
    expect(values).not.toContain("XX0002");
    // Non-comment XX0001/XX0002 lines (those that start with the prefix
    // followed by a space, not *) still feed code into the token stream.
    expect(values).toContain("EXEC");
    expect(values).toContain("SELECT");
    expect(values).toContain("CUSTOMERS");
  });

  it("strips col-7 `*` comments even when the file is otherwise free-format (mixed-mode corpora — #20 phase A)", () => {
    // The real-world failure mode this fix targets: a file the heuristic
    // classifies as free-format (because most lines start at col 1) but
    // that still has legacy fixed-format comment lines (`*` at col 7).
    // Pre-fix, those tokenized as code and produced phantom dataflow edges.
    // Six leading-spaces puts the `*` at index 6 (col 7); the rest of the
    // file is free-format COBOL starting at col 1.
    const source = [
      "      * THIS IS A LEGACY COMMENT LINE",
      "      * MOVE GHOST-FIELD TO PHANTOM-VAR",
      "IDENTIFICATION DIVISION.",
      "PROGRAM-ID. MIXED.",
      "PROCEDURE DIVISION.",
      "    MOVE A TO B.",
    ].join("\n");
    const tokens = tokenize(source);
    const values = tokens.map((t) => t.value);
    // Comment-line tokens must be filtered.
    expect(values).not.toContain("GHOST-FIELD");
    expect(values).not.toContain("PHANTOM-VAR");
    expect(values).not.toContain("LEGACY");
    // Free-format code below stays intact.
    expect(values).toContain("IDENTIFICATION");
    expect(values).toContain("MOVE");
    expect(values).toContain("A");
    expect(values).toContain("B");
  });

  it("does NOT misfire on free-format code where col 7 happens to be alphanumeric", () => {
    // Defensive: the col-7 `*` filter only fires on `*`. Other characters
    // at index 6 (letters, digits, hyphens) must NOT be treated as comment
    // indicators in free-format mode.
    const source = [
      "PROGRAM-ID. SAMPLE.",  // index 6 = 'M' (PROGRA[M])
      "PROCEDURE DIVISION.",  // index 6 = 'U' (PROCED[U])
      "MOVE-IT SECTION.",     // index 6 = 'T' (MOVE-I[T])
    ].join("\n");
    const tokens = tokenize(source);
    const values = tokens.map((t) => t.value);
    expect(values).toContain("PROGRAM-ID");
    expect(values).toContain("PROCEDURE");
    expect(values).toContain("MOVE-IT");
  });
});
