import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
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
import type { NormalizedCodeModel, CodeAnalysisPlugin } from "../../code-analysis.js";
import { Wiki } from "../../wiki.js";
import { handleTool } from "../../server.js";

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

  describe("COBOL plugin generateWikiPages (non-empty)", () => {
    const source = fixture("PAYROLL.cbl");
    const ast = cobolPlugin.parse(source, "PAYROLL.cbl");
    const model = cobolPlugin.normalize(ast);
    const pages = cobolPlugin.generateWikiPages(model, "PAYROLL.cbl", ast);

    it("returns at least one wiki page", () => {
      expect(pages.length).toBeGreaterThanOrEqual(1);
    });

    it("generates a program page with correct path", () => {
      expect(pages[0].path).toBe("cobol/programs/payroll.md");
    });

    it("page content includes PAYROLL", () => {
      expect(pages[0].content).toContain("PAYROLL");
    });
  });

  describe("mock second-language plugin dispatches through MCP tools", () => {
    // Minimal mock plugin to prove server dispatch is generic
    const mockPlugin: CodeAnalysisPlugin = {
      id: "mockjava",
      languages: ["MockJava"],
      extensions: [".mjava"],
      parse(_source: string, filename: string) {
        return { type: "MockAST", file: filename };
      },
      normalize(_ast: unknown): NormalizedCodeModel {
        return {
          units: [{ name: "MockClass", kind: "class", language: "MockJava", sourceFile: "Test.mjava" }],
          procedures: [{ name: "main", kind: "method", loc: { line: 1, column: 1 } }],
          symbols: [{ name: "x", kind: "variable", loc: { line: 2, column: 1 } }],
          relations: [],
          diagnostics: [],
        };
      },
      generateWikiPages(_model, sourceFile) {
        return [{
          path: `mockjava/${sourceFile.replace(/\.[^.]+$/, "")}.md`,
          content: `---\ntitle: "MockClass"\ntype: code\ntags: [mockjava]\n---\n\nMock page.\n`,
        }];
      },
    };

    let wiki: Wiki;
    let tmp: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "mock-plugin-test-"));
      wiki = Wiki.init(tmp);
      registerPlugin(mockPlugin);
    });

    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it("code_parse dispatches through mock plugin", async () => {
      // Add a .mjava file to raw/ with explicit text MIME so rawRead returns content
      wiki.rawAdd("Test.mjava", { content: "class MockClass { void main() { int x = 1; } }", mimeType: "text/plain" });

      const result = await handleTool(wiki, "code_parse", { path: "Test.mjava" });
      expect(typeof result).toBe("string");
      const parsed = JSON.parse(result as string);

      // Summary comes from summarizeModel on NormalizedCodeModel
      expect(parsed.summary.unitName).toBe("MockClass");
      expect(parsed.summary.language).toBe("MockJava");
      expect(parsed.summary.procedureCount).toBe(1);
      expect(parsed.summary.symbolCount).toBe(1);

      // Wiki page was generated by the mock plugin
      expect(parsed.wikiPages).toContain("mockjava/Test.md");
    });

    it("code_trace_variable reports not supported for plugin without tracer", async () => {
      wiki.rawAdd("Test.mjava", { content: "class Test {}", mimeType: "text/plain" });
      const result = await handleTool(wiki, "code_trace_variable", {
        path: "Test.mjava",
        variable: "x",
      });
      expect(result).toContain("does not support variable tracing");
    });
  });
});
