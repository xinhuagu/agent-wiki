import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "../parser.js";
import { extractModel, generateSummary } from "../extractors.js";
import { generateProgramPage, generateCopybookPage, generateCallGraphPage } from "../wiki-gen.js";

const FIXTURES = resolve(process.cwd(), "src/cobol/__tests__/fixtures");
const fixture = (name: string) => readFileSync(resolve(FIXTURES, name), "utf-8");

describe("COBOL wiki page generation", () => {
  describe("program page", () => {
    const ast = parse(fixture("PAYROLL.cbl"), "PAYROLL.cbl");
    const model = extractModel(ast);
    const summary = generateSummary(model);
    const page = generateProgramPage(model, summary);

    it("generates correct path", () => {
      expect(page.path).toBe("cobol/programs/payroll.md");
    });

    it("includes frontmatter", () => {
      expect(page.content).toContain('title: "PAYROLL"');
      expect(page.content).toContain("type: code");
      expect(page.content).toContain("tags: [cobol, program]");
      expect(page.content).toContain('sources: ["raw/PAYROLL.cbl"]');
    });

    it("includes program structure table", () => {
      expect(page.content).toContain("## Program Structure");
      expect(page.content).toContain("IDENTIFICATION");
      expect(page.content).toContain("PROCEDURE");
    });

    it("includes dependencies", () => {
      expect(page.content).toContain("## Dependencies");
      expect(page.content).toContain("CALC-TAX");
      expect(page.content).toContain("PRINT-REPORT");
    });

    it("includes key data items", () => {
      expect(page.content).toContain("## Key Data Items");
    });

    it("includes file definitions", () => {
      expect(page.content).toContain("## File Definitions");
      expect(page.content).toContain("EMPLOYEE-FILE");
    });
  });

  describe("copybook page", () => {
    const ast = parse(fixture("DATE-UTILS.cpy"), "DATE-UTILS.cpy");
    const model = extractModel(ast);
    const page = generateCopybookPage(model);

    it("generates correct path", () => {
      expect(page.path).toBe("cobol/copybooks/date-utils.md");
    });

    it("includes copybook frontmatter", () => {
      expect(page.content).toContain('title: "DATE-UTILS"');
      expect(page.content).toContain("tags: [cobol, copybook]");
    });
  });

  describe("call graph page", () => {
    const ast1 = parse(fixture("PAYROLL.cbl"), "PAYROLL.cbl");
    const model1 = extractModel(ast1);
    const page = generateCallGraphPage([model1]);

    it("generates correct path", () => {
      expect(page.path).toBe("cobol/call-graph.md");
    });

    it("includes CALL dependencies", () => {
      expect(page.content).toContain("## CALL Dependencies");
      expect(page.content).toContain("PAYROLL");
      expect(page.content).toContain("CALC-TAX");
    });

    it("has synthesis type", () => {
      expect(page.content).toContain("type: synthesis");
    });
  });
});
