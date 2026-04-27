import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "fs";
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

    it("produces file-access relations from parsed file operations", () => {
      const fileAccesses = model.relations.filter((r) => r.type === "file-access");
      expect(fileAccesses.length).toBeGreaterThanOrEqual(3);
      expect(fileAccesses.some((r) => r.to === "EMPLOYEE-FILE" && r.metadata?.operation === "OPEN")).toBe(true);
      expect(fileAccesses.some((r) => r.to === "EMPLOYEE-FILE" && r.metadata?.operation === "READ")).toBe(true);
      expect(fileAccesses.some((r) => r.to === "EMPLOYEE-FILE" && r.metadata?.operation === "CLOSE")).toBe(true);
    });

    it("has no diagnostics for valid source", () => {
      expect(model.diagnostics).toEqual([]);
    });
  });

  describe("external dependency extraction", () => {
    it("extracts DB2 table references and normalizes them into relations", () => {
      const source = fixture("CUSTOMER-DB2.cbl");
      const ast = cobolPlugin.parse(source, "CUSTOMER-DB2.cbl");
      const cobolModel = extractModel(ast as ReturnType<typeof parse>);
      const model = cobolPlugin.normalize(ast) as NormalizedCodeModel;

      expect(cobolModel.db2References).toHaveLength(1);
      expect(cobolModel.db2References[0].operation).toBe("SELECT");
      expect(cobolModel.db2References[0].tables).toEqual(["CUSTOMER_STATUS", "CUSTOMER_TABLE"]);

      const db2Tables = model.relations.filter((r) => r.type === "db2-table");
      expect(db2Tables.map((r) => r.to)).toEqual(["CUSTOMER_STATUS", "CUSTOMER_TABLE"]);
      expect(db2Tables.every((r) => r.metadata?.operation === "SELECT")).toBe(true);
    });

    it("extracts CICS external targets and normalizes them into relations", () => {
      const source = fixture("ONLINE-CICS.cbl");
      const ast = cobolPlugin.parse(source, "ONLINE-CICS.cbl");
      const cobolModel = extractModel(ast as ReturnType<typeof parse>);
      const model = cobolPlugin.normalize(ast) as NormalizedCodeModel;

      expect(cobolModel.cicsReferences).toHaveLength(1);
      expect(cobolModel.cicsReferences[0]).toMatchObject({
        command: "LINK",
        program: "CUSTSRV",
        transaction: "C001",
        map: "CUSTMAP",
      });

      expect(model.relations.some((r) => r.type === "cics-program" && r.to === "CUSTSRV")).toBe(true);
      expect(model.relations.some((r) => r.type === "cics-transaction" && r.to === "C001")).toBe(true);
      expect(model.relations.some((r) => r.type === "cics-map" && r.to === "CUSTMAP")).toBe(true);
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

    it("page content includes external dependency summaries", () => {
      expect(pages[0].content).toContain("External Dependencies");
      expect(pages[0].content).toContain("File Access");
      expect(pages[0].content).toContain("EMPLOYEE-FILE");
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

      // No extractLanguageModel → no model.json in artifacts
      expect(parsed.artifacts.every((a: string) => !a.includes(".model.json"))).toBe(true);
    });

    it("code_trace_variable reports not supported for plugin without tracer", async () => {
      wiki.rawAdd("Test.mjava", { content: "class Test {}", mimeType: "text/plain" });
      await expect(handleTool(wiki, "code_trace_variable", {
        path: "Test.mjava",
        variable: "x",
      })).rejects.toThrow(/does not support variable tracing/);
    });
  });

  describe("plugin with extractLanguageModel and rebuildAggregatePages", () => {
    const richPlugin: CodeAnalysisPlugin = {
      id: "richlang",
      languages: ["RichLang"],
      extensions: [".rl"],
      parse(_source, filename) {
        return { kind: "RichAST", file: filename };
      },
      normalize(): NormalizedCodeModel {
        return {
          units: [{ name: "RichMod", kind: "module", language: "RichLang", sourceFile: "mod.rl" }],
          procedures: [],
          symbols: [],
          relations: [{ type: "import", from: "RichMod", to: "dep", loc: { line: 1, column: 1 } }],
          diagnostics: [],
        };
      },
      generateWikiPages(_model, sourceFile) {
        return [{ path: `richlang/${sourceFile.replace(/\.[^.]+$/, "")}.md`, content: "---\ntitle: Rich\n---\n" }];
      },
      extractLanguageModel(ast) {
        return { richDetail: true, ast };
      },
      rebuildAggregatePages(_parsedDir) {
        return [{ path: "richlang/deps.md", content: "---\ntitle: Deps\ntype: synthesis\n---\n\nDeps page.\n" }];
      },
    };

    let wiki: Wiki;
    let tmp: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "rich-plugin-test-"));
      wiki = Wiki.init(tmp);
      registerPlugin(richPlugin);
    });

    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it("persists language-specific model.json via extractLanguageModel hook", async () => {
      wiki.rawAdd("mod.rl", { content: "module RichMod", mimeType: "text/plain" });
      const result = await handleTool(wiki, "code_parse", { path: "mod.rl" });
      const parsed = JSON.parse(result as string);

      // model.json should be in artifacts
      expect(parsed.artifacts).toContain("raw/parsed/richlang/mod.model.json");

      // Verify the file was actually written
      const modelPath = join(tmp, "raw", "parsed", "richlang", "mod.model.json");
      expect(existsSync(modelPath)).toBe(true);
      const model = JSON.parse(readFileSync(modelPath, "utf-8"));
      expect(model.richDetail).toBe(true);
    });

    it("writes aggregate pages via rebuildAggregatePages hook", async () => {
      wiki.rawAdd("mod.rl", { content: "module RichMod", mimeType: "text/plain" });
      const result = await handleTool(wiki, "code_parse", { path: "mod.rl" });
      const parsed = JSON.parse(result as string);

      expect(parsed.wikiPages).toContain("richlang/deps.md");

      // Verify page was written to wiki/
      const depsPath = join(tmp, "wiki", "richlang", "deps.md");
      expect(existsSync(depsPath)).toBe(true);
    });
  });
});
