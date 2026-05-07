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

    it("extracts CALL USING positional args", () => {
      const calcTax = model.calls.find((c) => c.target === "CALC-TAX");
      expect(calcTax!.usingArgs).toEqual(["EMP-SALARY", "WS-TAX-AMOUNT"]);
      const printReport = model.calls.find((c) => c.target === "PRINT-REPORT");
      expect(printReport!.usingArgs).toEqual(["WS-TOTALS"]);
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

  describe("COPY REPLACING detection (#21)", () => {
    // Pre-#21 the parser tried to find REPLACING in stmt.operands, but
    // REPLACING/BY are typed keyword tokens excluded from operands, so
    // detection always failed and `c.replacing` was always undefined.
    // The fix uses rawText.indexOf("REPLACING") instead — best-effort
    // tokenization that produces a non-empty array on detection.
    function copyModel(source: string) {
      const ast = parse(`
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CP-RPL.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       ${source}
       PROCEDURE DIVISION.
       A100.
           STOP RUN.
`, "CP-RPL.cbl");
      return extractModel(ast);
    }

    it("plain COPY (no REPLACING) leaves c.replacing undefined", () => {
      const model = copyModel("           COPY CUSTID.");
      expect(model.copies).toHaveLength(1);
      expect(model.copies[0].replacing).toBeUndefined();
    });

    it("COPY ... REPLACING X BY Y (single-token) populates c.replacing", () => {
      const model = copyModel("           COPY CUSTID REPLACING CUST-ID BY ORDER-ID.");
      expect(model.copies).toHaveLength(1);
      expect(model.copies[0].replacing).toBeDefined();
      expect(model.copies[0].replacing!.length).toBeGreaterThan(0);
      // Single-token form tokenizes cleanly: ["CUST-ID", "BY", "ORDER-ID"]
      expect(model.copies[0].replacing).toContain("CUST-ID");
      expect(model.copies[0].replacing).toContain("ORDER-ID");
    });

    it("COPY ... REPLACING ==X== BY ==Y== (pseudo-text) produces non-empty array", () => {
      // Pseudo-text form shatters because `=` lexes as a single-char
      // operator. The resulting array is messy but length > 0, which is
      // what consumers (field-lineage exact-program filter, graph reason
      // marker, plugin metadata flag, db2-table-lineage rationale gate)
      // need to detect REPLACING presence. Fully structured pseudo-text
      // parsing is out of scope.
      const model = copyModel("           COPY CUSTID REPLACING ==CUST-== BY ==ORDER-==.");
      expect(model.copies).toHaveLength(1);
      expect(model.copies[0].replacing).toBeDefined();
      expect(model.copies[0].replacing!.length).toBeGreaterThan(0);
    });

    it("multiple REPLACING pairs in one COPY all surface in c.replacing", () => {
      const model = copyModel(
        "           COPY CUSTID REPLACING A BY X B BY Y."
      );
      expect(model.copies[0].replacing).toContain("A");
      expect(model.copies[0].replacing).toContain("X");
      expect(model.copies[0].replacing).toContain("B");
      expect(model.copies[0].replacing).toContain("Y");
    });
  });

  describe("CALL USING arg extraction", () => {
    it("returns empty usingArgs when CALL has no USING clause", () => {
      const src = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. NOPARM.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           CALL "OTHER".
           STOP RUN.
`;
      const model = extractModel(parse(src, "NOPARM.cbl"));
      expect(model.calls).toHaveLength(1);
      expect(model.calls[0].usingArgs).toEqual([]);
    });

    it("skips BY REFERENCE / BY CONTENT / BY VALUE modifiers", () => {
      const src = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. WITHMOD.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           CALL "T" USING BY REFERENCE A BY CONTENT B BY VALUE C.
           STOP RUN.
`;
      const model = extractModel(parse(src, "WITHMOD.cbl"));
      expect(model.calls[0].usingArgs).toEqual(["A", "B", "C"]);
    });

    it("records targetKind=literal for CALL \"NAME\" and CALL 'NAME'", () => {
      const src = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. LITERALCALL.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           CALL "DOUBLEQUOTED" USING WS-A.
           CALL 'SINGLEQUOTED' USING WS-A.
           STOP RUN.
`;
      const model = extractModel(parse(src, "LITERALCALL.cbl"));
      expect(model.calls).toHaveLength(2);
      expect(model.calls[0].target).toBe("DOUBLEQUOTED");
      expect(model.calls[0].targetKind).toBe("literal");
      expect(model.calls[1].target).toBe("SINGLEQUOTED");
      expect(model.calls[1].targetKind).toBe("literal");
    });

    it("records targetKind=identifier for CALL <variable> (dynamic call)", () => {
      const src = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. DYNAMIC.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-PROG-NAME       PIC X(8).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           CALL WS-PROG-NAME USING WS-A.
           STOP RUN.
`;
      const model = extractModel(parse(src, "DYNAMIC.cbl"));
      expect(model.calls).toHaveLength(1);
      expect(model.calls[0].target).toBe("WS-PROG-NAME");
      expect(model.calls[0].targetKind).toBe("identifier");
    });

    it("stops at GIVING / RETURNING / END-CALL", () => {
      const src = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. WITHGIV.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           CALL "TARGET" USING WS-IN WS-OUT GIVING WS-RC.
           STOP RUN.
`;
      const model = extractModel(parse(src, "WITHGIV.cbl"));
      expect(model.calls[0].usingArgs).toEqual(["WS-IN", "WS-OUT"]);
    });
  });

  describe("LINKAGE SECTION extraction", () => {
    it("populates linkageItems with LINKAGE-only top-level records, in source order", () => {
      const src = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CALLEE.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-LOCAL          PIC X(10).
       LINKAGE SECTION.
       01  LK-FIRST.
           05  LK-FIRST-ID    PIC 9(8).
       01  LK-SECOND          PIC X(20).
       PROCEDURE DIVISION USING LK-FIRST LK-SECOND.
       A000-MAIN SECTION.
       A100-START.
           GOBACK.
`;
      const model = extractModel(parse(src, "CALLEE.cbl"));
      expect(model.linkageItems.map((item) => item.name)).toEqual(["LK-FIRST", "LK-SECOND"]);
      expect(model.linkageItems[0].children.map((c) => c.name)).toEqual(["LK-FIRST-ID"]);
      // dataItems still includes both LINKAGE and WORKING-STORAGE items
      const allNames = model.dataItems.map((item) => item.name);
      expect(allNames).toContain("WS-LOCAL");
      expect(allNames).toContain("LK-FIRST");
      expect(allNames).toContain("LK-SECOND");
    });

    it("returns empty linkageItems when no LINKAGE section is present", () => {
      const src = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. NOLINK.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  WS-X               PIC X(5).
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;
      const model = extractModel(parse(src, "NOLINK.cbl"));
      expect(model.linkageItems).toEqual([]);
    });
  });
});
