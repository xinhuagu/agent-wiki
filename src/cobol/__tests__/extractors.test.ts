import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "../parser.js";
import { extractModel, generateSummary } from "../extractors.js";

const FIXTURES = resolve(process.cwd(), "src/cobol/__tests__/fixtures");
const fixture = (name: string) => readFileSync(resolve(FIXTURES, name), "utf-8");

describe("COBOL extractors", () => {
  describe("PAYROLL.cbl model extraction", () => {
    const ast = parse(fixture("PAYROLL.cbl"), "PAYROLL.cbl");
    const model = extractModel(ast);

    it("extracts program ID", () => {
      expect(model.programId).toBe("PAYROLL");
    });

    it("extracts all divisions", () => {
      const names = model.divisions.map((d) => d.name);
      expect(names).toContain("IDENTIFICATION");
      expect(names).toContain("DATA");
      expect(names).toContain("PROCEDURE");
    });

    it("extracts sections with division names", () => {
      const procSections = model.sections.filter((s) => s.division === "PROCEDURE");
      expect(procSections.length).toBeGreaterThanOrEqual(3);
    });

    it("extracts paragraphs with section names", () => {
      expect(model.paragraphs.length).toBeGreaterThanOrEqual(4);
      const b100 = model.paragraphs.find((p) => p.name === "B100-READ");
      expect(b100).toBeDefined();
      expect(b100!.section).toBe("B000-PROCESS");
    });

    it("extracts CALL relations", () => {
      expect(model.calls.length).toBe(2);
      const targets = model.calls.map((c) => c.target);
      expect(targets).toContain("CALC-TAX");
      expect(targets).toContain("PRINT-REPORT");
    });

    it("extracts PERFORM relations", () => {
      expect(model.performs.length).toBeGreaterThanOrEqual(2);
      const targets = model.performs.map((p) => p.target);
      expect(targets).toContain("B000-PROCESS");
      expect(targets).toContain("C000-FINALIZE");
    });

    it("extracts PERFORM THRU", () => {
      const thruPerform = model.performs.find((p) => p.thru !== undefined);
      expect(thruPerform).toBeDefined();
      expect(thruPerform!.target).toBe("B000-PROCESS");
      expect(thruPerform!.thru).toBe("B999-PROCESS-EXIT");
    });

    it("extracts file definitions", () => {
      expect(model.fileDefinitions.length).toBe(1);
      expect(model.fileDefinitions[0].fd).toBe("EMPLOYEE-FILE");
    });

    it("extracts data items", () => {
      expect(model.dataItems.length).toBeGreaterThan(0);
    });
  });

  describe("PAYROLL.cbl summary generation", () => {
    const ast = parse(fixture("PAYROLL.cbl"), "PAYROLL.cbl");
    const model = extractModel(ast);
    const summary = generateSummary(model);

    it("generates correct summary", () => {
      expect(summary.programId).toBe("PAYROLL");
      expect(summary.callTargets).toContain("CALC-TAX");
      expect(summary.callTargets).toContain("PRINT-REPORT");
      expect(summary.copybooks).toEqual([]);
      expect(summary.fileDefinitions).toEqual(["EMPLOYEE-FILE"]);
      expect(summary.dataItemCount).toBeGreaterThan(0);
    });
  });

  describe("INVOICE.cbl — COPY in DATA DIVISION", () => {
    const ast = parse(fixture("INVOICE.cbl"), "INVOICE.cbl");
    const model = extractModel(ast);
    const summary = generateSummary(model);

    it("extracts COPY dependencies from WORKING-STORAGE", () => {
      const copybooks = model.copies.map((c) => c.copybook);
      expect(copybooks).toContain("DATE-UTILS");
      expect(copybooks).toContain("CUSTOMER-REC");
    });

    it("extracts COPY dependencies from LINKAGE SECTION", () => {
      const copybooks = model.copies.map((c) => c.copybook);
      expect(copybooks).toContain("LINK-PARAMS");
    });

    it("includes all copybooks in summary", () => {
      expect(summary.copybooks).toContain("DATE-UTILS");
      expect(summary.copybooks).toContain("CUSTOMER-REC");
      expect(summary.copybooks).toContain("LINK-PARAMS");
      expect(summary.copybooks.length).toBe(3);
    });

    it("still extracts CALL from PROCEDURE DIVISION", () => {
      expect(summary.callTargets).toContain("CALC-TOTAL");
    });

    it("still extracts data items alongside COPY", () => {
      expect(model.dataItems.length).toBeGreaterThan(0);
      const invoice = model.dataItems.find((d) => d.name === "WS-INVOICE-NUM");
      expect(invoice).toBeDefined();
    });
  });
});
