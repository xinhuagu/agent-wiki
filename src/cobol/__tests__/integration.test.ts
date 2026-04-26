import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { Wiki } from "../../wiki.js";
import { handleTool } from "../../server.js";

const FIXTURES = resolve(process.cwd(), "src/cobol/__tests__/fixtures");

describe("COBOL MCP tools integration", () => {
  let wiki: Wiki;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cobol-test-"));
    wiki = Wiki.init(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("code_parse succeeds end-to-end with a .cbl file", async () => {
    const source = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
    wiki.rawAdd("PAYROLL.cbl", { content: source });

    const result = await handleTool(wiki, "code_parse", { path: "PAYROLL.cbl" });
    expect(typeof result).toBe("string");
    const parsed = JSON.parse(result as string);
    expect(parsed.summary.unitName).toBe("PAYROLL");
    expect(parsed.artifacts.length).toBe(5); // ast, normalized, summary, model, knowledge-graph
    expect(parsed.artifacts).toContain("raw/parsed/cobol/PAYROLL.model.json");
    expect(parsed.artifacts).toContain("raw/parsed/cobol/knowledge-graph.json");
    expect(parsed.wikiPages).toContain("cobol/programs/payroll.md");
    expect(parsed.wikiPages).toContain("cobol/system-map.md");

    // Verify wiki page was actually written to disk
    const wikiPage = join(tmp, "wiki", "cobol", "programs", "payroll.md");
    expect(existsSync(wikiPage)).toBe(true);
    const pageContent = readFileSync(wikiPage, "utf-8");
    expect(pageContent).toContain("PAYROLL");

    // Verify normalized model artifact exists
    const normalized = join(tmp, "raw", "parsed", "cobol", "PAYROLL.normalized.json");
    expect(existsSync(normalized)).toBe(true);
    const normalizedContent = JSON.parse(readFileSync(normalized, "utf-8"));
    expect(normalizedContent.units).toBeDefined();
    expect(normalizedContent.units[0].language).toBe("COBOL");
  });

  it("code_parse with trace_variable returns variable references", async () => {
    const source = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
    wiki.rawAdd("PAYROLL.cbl", { content: source });

    const result = await handleTool(wiki, "code_parse", {
      path: "PAYROLL.cbl",
      trace_variable: "WS-TOTAL-SALARY",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.variableTrace).toBeDefined();
    expect(parsed.variableTrace.length).toBeGreaterThan(0);
  });

  it("code_trace_variable succeeds end-to-end", async () => {
    const source = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
    wiki.rawAdd("PAYROLL.cbl", { content: source });

    const result = await handleTool(wiki, "code_trace_variable", {
      path: "PAYROLL.cbl",
      variable: "EMP-SALARY",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.variable).toBe("EMP-SALARY");
    expect(parsed.references.length).toBeGreaterThan(0);
  });

  it("code_parse succeeds with a .cpy copybook", async () => {
    const source = readFileSync(join(FIXTURES, "DATE-UTILS.cpy"), "utf-8");
    wiki.rawAdd("DATE-UTILS.cpy", { content: source });

    const result = await handleTool(wiki, "code_parse", { path: "DATE-UTILS.cpy" });
    const parsed = JSON.parse(result as string);
    expect(parsed.summary.symbolCount).toBeGreaterThan(0);
    expect(parsed.wikiPages).toContain("cobol/copybooks/date-utils.md");
  });

  it("code_parse generates knowledge graph with correct node identities", async () => {
    // Parse two programs + one copybook to verify cross-file graph
    const payrollSrc = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
    const invoiceSrc = readFileSync(join(FIXTURES, "INVOICE.cbl"), "utf-8");
    const dateUtilsSrc = readFileSync(join(FIXTURES, "DATE-UTILS.cpy"), "utf-8");
    wiki.rawAdd("PAYROLL.cbl", { content: payrollSrc });
    wiki.rawAdd("INVOICE.cbl", { content: invoiceSrc });
    wiki.rawAdd("DATE-UTILS.cpy", { content: dateUtilsSrc });

    // Parse all three — graph is rebuilt on each call
    await handleTool(wiki, "code_parse", { path: "PAYROLL.cbl" });
    await handleTool(wiki, "code_parse", { path: "INVOICE.cbl" });
    const result = await handleTool(wiki, "code_parse", { path: "DATE-UTILS.cpy" });
    const parsed = JSON.parse(result as string);

    // Graph summary present in output
    expect(parsed.knowledgeGraph).toBeDefined();
    expect(parsed.knowledgeGraph.nodes).toBeGreaterThan(0);
    expect(parsed.knowledgeGraph.edges).toBeGreaterThan(0);

    // Read the persisted graph JSON
    const graphPath = join(tmp, "raw", "parsed", "cobol", "knowledge-graph.json");
    expect(existsSync(graphPath)).toBe(true);
    const graph = JSON.parse(readFileSync(graphPath, "utf-8"));

    // Verify canonical IDs: namespaced, no extensions
    const nodeIds = graph.nodes.map((n: { id: string }) => n.id);
    expect(nodeIds).toContain("program:PAYROLL");
    expect(nodeIds).toContain("program:INVOICE");
    expect(nodeIds).toContain("copybook:DATE-UTILS");

    // DATE-UTILS should be resolved (source-backed) — no .cpy in ID
    const dateUtils = graph.nodes.find((n: { id: string }) => n.id === "copybook:DATE-UTILS");
    expect(dateUtils.resolved).toBe(true);

    // CALC-TOTAL is referenced but never parsed — should be unresolved
    const calcTotal = graph.nodes.find((n: { id: string }) => n.id === "program:CALC-TOTAL");
    expect(calcTotal).toBeDefined();
    expect(calcTotal.resolved).toBe(false);

    // EMPLOYEE-FILE dataset should be resolved (FD-backed)
    const empFile = graph.nodes.find((n: { id: string }) => n.id === "dataset:EMPLOYEE-FILE");
    expect(empFile).toBeDefined();
    expect(empFile.resolved).toBe(true);

    // Diagnostics should flag unresolved nodes
    expect(graph.diagnostics.length).toBeGreaterThan(0);
    const unresolvedDiags = graph.diagnostics.filter(
      (d: { message: string }) => d.message.includes("Unresolved")
    );
    expect(unresolvedDiags.length).toBeGreaterThan(0);

    // System map wiki page should exist
    const systemMap = join(tmp, "wiki", "cobol", "system-map.md");
    expect(existsSync(systemMap)).toBe(true);
    const mapContent = readFileSync(systemMap, "utf-8");
    expect(mapContent).toContain("COBOL System Map");
    expect(mapContent).toContain("PAYROLL");
    expect(mapContent).toContain("unresolved");
  });

  it("rejects unsupported file types", async () => {
    await expect(handleTool(wiki, "code_parse", { path: "readme.md" }))
      .rejects.toThrow(/Unsupported file type/);
  });

  it("parsed artifacts pass lint integrity checks (no missing-meta)", async () => {
    const source = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
    wiki.rawAdd("PAYROLL.cbl", { content: source });
    await handleTool(wiki, "code_parse", { path: "PAYROLL.cbl" });

    const verifyResults = wiki.rawVerify();
    const missingMeta = verifyResults.filter((r) => r.status === "missing-meta");
    expect(missingMeta).toEqual([]);
  });

  describe("deferred graph rebuild (O(N) batch path)", () => {
    it("skipGraphRebuild prevents knowledge-graph.json and system-map.md generation", async () => {
      const source = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
      wiki.rawAdd("PAYROLL.cbl", { content: source });

      // Parse with graph rebuild skipped
      const result = await handleTool(wiki, "code_parse", { path: "PAYROLL.cbl" }, { skipGraphRebuild: true });
      const parsed = JSON.parse(result as string);

      // Core parse artifacts still written
      expect(parsed.artifacts).toContain("raw/parsed/cobol/PAYROLL.model.json");
      expect(existsSync(join(tmp, "raw", "parsed", "cobol", "PAYROLL.model.json"))).toBe(true);

      // Graph artifacts NOT written
      expect(parsed.artifacts).not.toContain("raw/parsed/cobol/knowledge-graph.json");
      expect(parsed.knowledgeGraph).toBeUndefined();
      expect(existsSync(join(tmp, "raw", "parsed", "cobol", "knowledge-graph.json"))).toBe(false);
      expect(parsed.wikiPages).not.toContain("cobol/system-map.md");
    });

    it("batch code_parse defers graph rebuild to end — single rebuild for N files", async () => {
      const payrollSrc = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
      const invoiceSrc = readFileSync(join(FIXTURES, "INVOICE.cbl"), "utf-8");
      const dateUtilsSrc = readFileSync(join(FIXTURES, "DATE-UTILS.cpy"), "utf-8");
      wiki.rawAdd("PAYROLL.cbl", { content: payrollSrc });
      wiki.rawAdd("INVOICE.cbl", { content: invoiceSrc });
      wiki.rawAdd("DATE-UTILS.cpy", { content: dateUtilsSrc });

      // Batch parse all three — graph rebuild deferred to end
      const result = await handleTool(wiki, "batch", {
        operations: [
          { tool: "code_parse", args: { path: "PAYROLL.cbl" } },
          { tool: "code_parse", args: { path: "INVOICE.cbl" } },
          { tool: "code_parse", args: { path: "DATE-UTILS.cpy" } },
        ],
      });
      const batch = JSON.parse(result as string);

      // All 3 parses succeeded
      expect(batch.count).toBe(3);
      for (const r of batch.results) {
        expect(r.error).toBeUndefined();
      }

      // Per-parse results should NOT include graph artifacts (deferred)
      for (const r of batch.results) {
        expect(r.result.knowledgeGraph).toBeUndefined();
        expect(r.result.artifacts).not.toContain("raw/parsed/cobol/knowledge-graph.json");
      }

      // But the deferred rebuild at end of batch should have produced the graph
      const graphPath = join(tmp, "raw", "parsed", "cobol", "knowledge-graph.json");
      expect(existsSync(graphPath)).toBe(true);
      const graph = JSON.parse(readFileSync(graphPath, "utf-8"));

      // Graph contains all 3 parsed files
      const nodeIds = graph.nodes.map((n: { id: string }) => n.id);
      expect(nodeIds).toContain("program:PAYROLL");
      expect(nodeIds).toContain("program:INVOICE");
      expect(nodeIds).toContain("copybook:DATE-UTILS");

      // System map wiki page exists
      const systemMap = join(tmp, "wiki", "cobol", "system-map.md");
      expect(existsSync(systemMap)).toBe(true);
    });

    it("wiki_rebuild regenerates knowledge graph from existing parsed artifacts", async () => {
      const payrollSrc = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
      const invoiceSrc = readFileSync(join(FIXTURES, "INVOICE.cbl"), "utf-8");
      wiki.rawAdd("PAYROLL.cbl", { content: payrollSrc });
      wiki.rawAdd("INVOICE.cbl", { content: invoiceSrc });

      // Parse both with graph rebuild skipped
      await handleTool(wiki, "code_parse", { path: "PAYROLL.cbl" }, { skipGraphRebuild: true });
      await handleTool(wiki, "code_parse", { path: "INVOICE.cbl" }, { skipGraphRebuild: true });

      // No graph yet
      const graphPath = join(tmp, "raw", "parsed", "cobol", "knowledge-graph.json");
      expect(existsSync(graphPath)).toBe(false);

      // Explicit wiki_rebuild triggers graph generation
      const rebuildResult = await handleTool(wiki, "wiki_rebuild", {});
      const rebuildParsed = JSON.parse(rebuildResult as string);
      expect(rebuildParsed.ok).toBe(true);
      expect(rebuildParsed.message).toContain("Knowledge graph");

      // Graph now exists with both programs
      expect(existsSync(graphPath)).toBe(true);
      const graph = JSON.parse(readFileSync(graphPath, "utf-8"));
      const nodeIds = graph.nodes.map((n: { id: string }) => n.id);
      expect(nodeIds).toContain("program:PAYROLL");
      expect(nodeIds).toContain("program:INVOICE");
    });
  });
});
