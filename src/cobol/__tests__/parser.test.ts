import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "../parser.js";

const FIXTURES = resolve(process.cwd(), "src/cobol/__tests__/fixtures");
const fixture = (name: string) => readFileSync(resolve(FIXTURES, name), "utf-8");

describe("COBOL parser", () => {
  describe("HELLO.cbl", () => {
    const ast = parse(fixture("HELLO.cbl"), "HELLO.cbl");

    it("extracts PROGRAM-ID", () => {
      expect(ast.programId).toBe("HELLO");
    });

    it("finds all four divisions", () => {
      const names = ast.divisions.map((d) => d.name);
      expect(names).toEqual(["IDENTIFICATION", "ENVIRONMENT", "DATA", "PROCEDURE"]);
    });

    it("parses data items in WORKING-STORAGE", () => {
      const dataDivision = ast.divisions.find((d) => d.name === "DATA")!;
      const ws = dataDivision.sections.find((s) => s.name.includes("WORKING-STORAGE"));
      expect(ws).toBeDefined();
      expect(ws!.dataItems.length).toBeGreaterThanOrEqual(2);
      const nameItem = ws!.dataItems.find((d) => d.name === "WS-NAME");
      expect(nameItem).toBeDefined();
      expect(nameItem!.picture).toMatch(/X\(30\)/i);
    });

    it("parses PROCEDURE DIVISION sections and paragraphs", () => {
      const procDiv = ast.divisions.find((d) => d.name === "PROCEDURE")!;
      expect(procDiv.sections.length).toBeGreaterThanOrEqual(1);
      const mainSection = procDiv.sections[0];
      expect(mainSection.name).toBe("A000-MAIN");
      expect(mainSection.paragraphs.length).toBeGreaterThanOrEqual(1);
    });

    it("captures statements with verbs", () => {
      const procDiv = ast.divisions.find((d) => d.name === "PROCEDURE")!;
      const stmts = procDiv.sections.flatMap((s) =>
        s.paragraphs.flatMap((p) => p.statements)
      );
      const verbs = stmts.map((s) => s.verb);
      expect(verbs).toContain("MOVE");
      expect(verbs).toContain("DISPLAY");
      expect(verbs).toContain("STOP");
    });
  });

  describe("PAYROLL.cbl", () => {
    const ast = parse(fixture("PAYROLL.cbl"), "PAYROLL.cbl");

    it("extracts PROGRAM-ID", () => {
      expect(ast.programId).toBe("PAYROLL");
    });

    it("parses FILE SECTION with FD", () => {
      const dataDivision = ast.divisions.find((d) => d.name === "DATA")!;
      const fileSection = dataDivision.sections.find((s) => s.name === "FILE");
      expect(fileSection).toBeDefined();
      expect(fileSection!.fileDefinitions.length).toBe(1);
      expect(fileSection!.fileDefinitions[0].fd).toBe("EMPLOYEE-FILE");
    });

    it("parses nested data items (group structure)", () => {
      const dataDivision = ast.divisions.find((d) => d.name === "DATA")!;
      const ws = dataDivision.sections.find((s) => s.name.includes("WORKING-STORAGE"));
      expect(ws).toBeDefined();
      const totals = ws!.dataItems.find((d) => d.name === "WS-TOTALS");
      expect(totals).toBeDefined();
      expect(totals!.children.length).toBe(3);
      expect(totals!.children[0].name).toBe("WS-TOTAL-SALARY");
    });

    it("parses 88-level condition names", () => {
      const dataDivision = ast.divisions.find((d) => d.name === "DATA")!;
      const ws = dataDivision.sections.find((s) => s.name.includes("WORKING-STORAGE"));
      expect(ws).toBeDefined();
      const flags = ws!.dataItems.find((d) => d.name === "WS-FLAGS");
      expect(flags).toBeDefined();
      const eofFlag = flags!.children.find((d) => d.name === "WS-EOF-FLAG");
      expect(eofFlag).toBeDefined();
      // 88-level items should be children of WS-EOF-FLAG
      const conditions = eofFlag!.children.filter((d) => d.level === 88);
      expect(conditions.length).toBe(1);
      expect(conditions[0].name).toBe("EOF-REACHED");
    });

    it("parses 77-level items", () => {
      const dataDivision = ast.divisions.find((d) => d.name === "DATA")!;
      const ws = dataDivision.sections.find((s) => s.name.includes("WORKING-STORAGE"));
      expect(ws).toBeDefined();
      const level77 = ws!.dataItems.find((d) => d.level === 77);
      expect(level77).toBeDefined();
      expect(level77!.name).toBe("WS-TAX-AMOUNT");
    });

    it("parses multiple PROCEDURE sections", () => {
      const procDiv = ast.divisions.find((d) => d.name === "PROCEDURE")!;
      const sectionNames = procDiv.sections.map((s) => s.name);
      expect(sectionNames).toContain("A000-MAIN");
      expect(sectionNames).toContain("B000-PROCESS");
      expect(sectionNames).toContain("C000-FINALIZE");
    });

    it("captures CALL statements", () => {
      const procDiv = ast.divisions.find((d) => d.name === "PROCEDURE")!;
      const stmts = procDiv.sections.flatMap((s) =>
        s.paragraphs.flatMap((p) => p.statements)
      );
      const calls = stmts.filter((s) => s.verb === "CALL");
      expect(calls.length).toBe(2);
    });

    it("captures PERFORM statements", () => {
      const procDiv = ast.divisions.find((d) => d.name === "PROCEDURE")!;
      const stmts = procDiv.sections.flatMap((s) =>
        s.paragraphs.flatMap((p) => p.statements)
      );
      const performs = stmts.filter((s) => s.verb === "PERFORM");
      expect(performs.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("DATE-UTILS.cpy (copybook)", () => {
    const ast = parse(fixture("DATE-UTILS.cpy"), "DATE-UTILS.cpy");

    it("has no PROGRAM-ID", () => {
      expect(ast.programId).toBe("");
    });

    it("creates a synthetic DATA division for standalone data items", () => {
      expect(ast.divisions.length).toBe(1);
      expect(ast.divisions[0].name).toBe("DATA");
    });

    it("parses the top-level 01 group item", () => {
      const items = ast.divisions[0].sections[0].dataItems;
      expect(items.length).toBe(1);
      expect(items[0].name).toBe("WS-DATE-FIELDS");
      expect(items[0].level).toBe(1);
    });

    it("parses nested data items within the copybook", () => {
      const root = ast.divisions[0].sections[0].dataItems[0];
      // 05-level children: WS-CURRENT-DATE, WS-FORMATTED-DATE, WS-DATE-VALID
      expect(root.children.length).toBe(3);
      expect(root.children[0].name).toBe("WS-CURRENT-DATE");
    });

    it("parses deeply nested items (10-level)", () => {
      const currentDate = ast.divisions[0].sections[0].dataItems[0].children[0];
      // 10-level: WS-YEAR, WS-MONTH, WS-DAY
      expect(currentDate.children.length).toBe(3);
      expect(currentDate.children[0].name).toBe("WS-YEAR");
      expect(currentDate.children[0].picture).toMatch(/9\(4\)/i);
    });

    it("parses 88-level conditions in copybook", () => {
      const dateValid = ast.divisions[0].sections[0].dataItems[0].children[2]; // WS-DATE-VALID
      expect(dateValid.name).toBe("WS-DATE-VALID");
      const conditions = dateValid.children.filter((d) => d.level === 88);
      expect(conditions.length).toBe(2);
      expect(conditions[0].name).toBe("DATE-IS-VALID");
      expect(conditions[1].name).toBe("DATE-INVALID");
    });
  });

  describe("listing-extracted copybook with leading header (issue #28)", () => {
    // Compile-listing fragments often carry an 8-ish-line header where text
    // begins at columns other than 7 (here col 15), so the lexer's col-7
    // `*` comment filter doesn't strip it. Pre-fix, parseDataItems() saw a
    // leading IDENTIFIER on peek() and exited immediately — zero data items
    // for an otherwise valid copybook.
    const src = [
      "              Source Listing of SAMPLEREC",
      "              Compiled 2024-01-01",
      "              Library  SAMPLELIB",
      "              Author   EXAMPLE",
      "              =================================",
      "       01  SAMPLE-REC.",
      "           05  SAMPLE-ID    PIC X(8).",
      "           05  SAMPLE-DATA  PIC X(80).",
    ].join("\n");
    const ast = parse(src, "SAMPLEREC.cpy");

    it("creates a synthetic DATA division", () => {
      expect(ast.divisions.length).toBe(1);
      expect(ast.divisions[0].name).toBe("DATA");
    });

    it("parses data items despite the leading non-level header", () => {
      const items = ast.divisions[0].sections[0].dataItems;
      expect(items.length).toBe(1);
      expect(items[0].name).toBe("SAMPLE-REC");
      expect(items[0].level).toBe(1);
      expect(items[0].children.length).toBe(2);
      expect(items[0].children[0].name).toBe("SAMPLE-ID");
      expect(items[0].children[0].picture).toMatch(/X\(8\)/i);
      expect(items[0].children[1].name).toBe("SAMPLE-DATA");
    });
  });

  describe("PROGRAM-ID quoted-literal handling", () => {
    it("strips single quotes around the program name", () => {
      const src = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. 'MY-PROG'.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;
      const ast = parse(src, "quoted.cbl");
      expect(ast.programId).toBe("MY-PROG");
    });

    it("strips double quotes around the program name", () => {
      const src = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. "MY-PROG".
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;
      const ast = parse(src, "dq.cbl");
      expect(ast.programId).toBe("MY-PROG");
    });

    it("leaves unquoted PROGRAM-ID identifiers untouched", () => {
      const src = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. PLAIN-PROG.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;
      const ast = parse(src, "plain.cbl");
      expect(ast.programId).toBe("PLAIN-PROG");
    });
  });
});
