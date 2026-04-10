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
});
