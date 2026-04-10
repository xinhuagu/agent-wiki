import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "../parser.js";
import { extractModel } from "../extractors.js";
import { cobolPlugin } from "../plugin.js";
import {
  registerPlugin,
  getPluginForFile,
  getPlugin,
  listPlugins,
  summarizeModel,
} from "../../code-analysis.js";
import type { NormalizedCodeModel } from "../../code-analysis.js";

const FIXTURES = resolve(process.cwd(), "src/cobol/__tests__/fixtures");
const fixture = (name: string) => readFileSync(resolve(FIXTURES, name), "utf-8");

describe("code-analysis plugin system", () => {
  // Plugin is already registered via server.ts import, but register again to be safe
  registerPlugin(cobolPlugin);

  describe("plugin registry", () => {
    it("finds COBOL plugin by .cbl extension", () => {
      const plugin = getPluginForFile("PAYROLL.cbl");
      expect(plugin).not.toBeNull();
      expect(plugin!.id).toBe("cobol");
    });

    it("finds COBOL plugin by .cob extension", () => {
      expect(getPluginForFile("test.cob")?.id).toBe("cobol");
    });

    it("finds COBOL plugin by .cpy extension", () => {
      expect(getPluginForFile("COPY.cpy")?.id).toBe("cobol");
    });

    it("returns null for unsupported extensions", () => {
      expect(getPluginForFile("app.java")).toBeNull();
    });

    it("retrieves plugin by ID", () => {
      expect(getPlugin("cobol")?.id).toBe("cobol");
    });

    it("lists all registered plugins", () => {
      const plugins = listPlugins();
      expect(plugins.length).toBeGreaterThanOrEqual(1);
      expect(plugins.some((p) => p.id === "cobol")).toBe(true);
    });
  });

  describe("NormalizedCodeModel from COBOL", () => {
    const source = fixture("PAYROLL.cbl");
    const ast = cobolPlugin.parse(source, "PAYROLL.cbl");
    const model = cobolPlugin.normalize(ast) as NormalizedCodeModel;

    it("produces a program unit", () => {
      expect(model.units.length).toBe(1);
      expect(model.units[0].name).toBe("PAYROLL");
      expect(model.units[0].kind).toBe("program");
      expect(model.units[0].language).toBe("COBOL");
    });

    it("produces procedures (sections + paragraphs)", () => {
      const sections = model.procedures.filter((p) => p.kind === "section");
      const paragraphs = model.procedures.filter((p) => p.kind === "paragraph");
      expect(sections.length).toBeGreaterThanOrEqual(3);
      expect(paragraphs.length).toBeGreaterThanOrEqual(4);
    });

    it("produces symbols from data items", () => {
      expect(model.symbols.length).toBeGreaterThan(0);
      const empSalary = model.symbols.find((s) => s.name === "EMP-SALARY");
      expect(empSalary).toBeDefined();
      expect(empSalary!.kind).toBe("variable");
    });

    it("produces call relations", () => {
      const calls = model.relations.filter((r) => r.type === "call");
      expect(calls.length).toBe(2);
      const targets = calls.map((c) => c.to);
      expect(targets).toContain("CALC-TAX");
      expect(targets).toContain("PRINT-REPORT");
    });

    it("produces perform relations", () => {
      const performs = model.relations.filter((r) => r.type === "perform");
      expect(performs.length).toBeGreaterThanOrEqual(2);
    });

    it("has no diagnostics for valid source", () => {
      expect(model.diagnostics).toEqual([]);
    });
  });

  describe("NormalizedCodeModel from copybook", () => {
    const source = fixture("DATE-UTILS.cpy");
    const ast = cobolPlugin.parse(source, "DATE-UTILS.cpy");
    const model = cobolPlugin.normalize(ast) as NormalizedCodeModel;

    it("produces a copybook unit", () => {
      expect(model.units[0].kind).toBe("copybook");
    });

    it("produces symbols", () => {
      expect(model.symbols.length).toBeGreaterThan(0);
      expect(model.symbols.some((s) => s.name === "WS-DATE-FIELDS")).toBe(true);
    });
  });

  describe("summarizeModel", () => {
    const source = fixture("PAYROLL.cbl");
    const ast = cobolPlugin.parse(source, "PAYROLL.cbl");
    const model = cobolPlugin.normalize(ast) as NormalizedCodeModel;
    const summary = summarizeModel(model);

    it("produces correct summary", () => {
      expect(summary.unitName).toBe("PAYROLL");
      expect(summary.language).toBe("COBOL");
      expect(summary.procedureCount).toBeGreaterThan(0);
      expect(summary.symbolCount).toBeGreaterThan(0);
      expect(summary.relationsByType["call"]).toBe(2);
    });
  });

  describe("traceVariable via plugin", () => {
    const source = fixture("PAYROLL.cbl");
    const ast = cobolPlugin.parse(source, "PAYROLL.cbl");

    it("returns variable references via plugin interface", () => {
      const refs = cobolPlugin.traceVariable!(ast, "WS-TOTAL-SALARY");
      expect(refs.length).toBeGreaterThan(0);
      // Check that the adapter maps fields correctly
      expect(refs[0].procedure).toBeDefined();
      expect(refs[0].section).toBeDefined();
    });
  });
});
