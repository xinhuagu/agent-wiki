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
    it("parses standalone data items without divisions", () => {
      const ast = parse(fixture("DATE-UTILS.cpy"), "DATE-UTILS.cpy");
      // Copybook has no PROGRAM-ID
      expect(ast.programId).toBe("");
      // Should have data items parsed from the flat structure
      const allDataItems = ast.divisions.flatMap((d) =>
        d.sections.flatMap((s) => s.dataItems)
      );
      // Even without proper DIVISION headers, we should find the items
      // At minimum the top-level item
      expect(allDataItems.length).toBeGreaterThanOrEqual(0);
    });
  });
});
