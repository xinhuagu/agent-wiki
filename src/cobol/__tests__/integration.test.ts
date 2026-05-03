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

  it("code_query procedure_flow returns section and paragraph PERFORM flow", async () => {
    const source = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
    wiki.rawAdd("PAYROLL.cbl", { content: source });

    await handleTool(wiki, "code_parse", { path: "PAYROLL.cbl" });
    const result = await handleTool(wiki, "code_query", {
      query_type: "procedure_flow",
      path: "PAYROLL.cbl",
      procedure: "A100-INIT",
    });
    const parsed = JSON.parse(result as string);

    expect(parsed.query.type).toBe("procedure_flow");
    expect(parsed.summary.performRelations).toBeGreaterThanOrEqual(3);
    expect(parsed.sectionCalls.some((entry: { fromSection: string; toSection: string }) =>
      entry.fromSection === "A000-MAIN" && entry.toSection === "B000-PROCESS"
    )).toBe(true);
    expect(parsed.flowByDepth.length).toBeGreaterThanOrEqual(1);
    expect(parsed.flowByDepth[0].nodes.some((node: { name: string }) => node.name === "B000-PROCESS")).toBe(true);
    expect(parsed.flowByDepth[0].nodes.some((node: { name: string }) => node.name === "C000-FINALIZE")).toBe(true);
  });

  it("code_query procedure_flow supports section-focused traversal", async () => {
    const source = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
    wiki.rawAdd("PAYROLL.cbl", { content: source });

    await handleTool(wiki, "code_parse", { path: "PAYROLL.cbl" });
    const result = await handleTool(wiki, "code_query", {
      query_type: "procedure_flow",
      path: "PAYROLL.cbl",
      procedure: "A000-MAIN",
      procedure_kind: "section",
    });
    const parsed = JSON.parse(result as string);

    expect(parsed.focus.name).toBe("A000-MAIN");
    expect(parsed.focus.kind).toBe("section");
    expect(parsed.flowByDepth.length).toBeGreaterThanOrEqual(1);
    expect(parsed.flowByDepth[0].nodes.some((node: { name: string }) => node.name === "B000-PROCESS")).toBe(true);
    expect(parsed.flowByDepth[0].nodes.some((node: { name: string }) => node.name === "C000-FINALIZE")).toBe(true);
    const processNode = parsed.flowByDepth[0].nodes.find((node: { name: string }) => node.name === "B000-PROCESS");
    expect(processNode.via.some((edge: { viaParagraph: string | null }) => edge.viaParagraph === "A100-INIT")).toBe(true);
  });

  it("code_impact reports affected programs for a resolved copybook", async () => {
    const invoiceSrc = readFileSync(join(FIXTURES, "INVOICE.cbl"), "utf-8");
    const dateUtilsSrc = readFileSync(join(FIXTURES, "DATE-UTILS.cpy"), "utf-8");
    wiki.rawAdd("INVOICE.cbl", { content: invoiceSrc });
    wiki.rawAdd("DATE-UTILS.cpy", { content: dateUtilsSrc });

    await handleTool(wiki, "code_parse", { path: "INVOICE.cbl" });
    await handleTool(wiki, "code_parse", { path: "DATE-UTILS.cpy" });

    const result = await handleTool(wiki, "code_impact", {
      node_id: "DATE-UTILS",
      kind: "copybook",
    });
    const parsed = JSON.parse(result as string);

    expect(parsed.source.node_id).toBe("copybook:DATE-UTILS");
    expect(parsed.source.resolved).toBe(true);
    expect(parsed.summary.affectedNodes).toBeGreaterThanOrEqual(1);
    expect(parsed.impactedByDepth).toHaveLength(1);
    expect(parsed.impactedByDepth[0].depth).toBe(1);
    expect(parsed.impactedByDepth[0].nodes.some((n: { node_id: string }) => n.node_id === "program:INVOICE")).toBe(true);
    const invoice = parsed.impactedByDepth[0].nodes.find((n: { node_id: string }) => n.node_id === "program:INVOICE");
    expect(invoice.resolved).toBe(true);
    expect(invoice.via.some((e: { relationship: string; to: string }) => e.relationship === "COPIES" && e.to === "copybook:DATE-UTILS")).toBe(true);
  });

  it("code_impact works for unresolved source nodes and marks downstream warnings", async () => {
    const payrollSrc = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
    wiki.rawAdd("PAYROLL.cbl", { content: payrollSrc });

    await handleTool(wiki, "code_parse", { path: "PAYROLL.cbl" });

    const result = await handleTool(wiki, "code_impact", {
      node_id: "program:CALC-TAX",
    });
    const parsed = JSON.parse(result as string);

    expect(parsed.source.node_id).toBe("program:CALC-TAX");
    expect(parsed.source.resolved).toBe(false);
    expect(parsed.impactedByDepth).toHaveLength(1);
    const level1 = parsed.impactedByDepth[0];
    expect(level1.nodes.some((n: { node_id: string }) => n.node_id === "program:PAYROLL")).toBe(true);
    const payroll = level1.nodes.find((n: { node_id: string }) => n.node_id === "program:PAYROLL");
    expect(payroll.via.some((e: { relationship: string; to: string }) => e.relationship === "CALLS" && e.to === "program:CALC-TAX")).toBe(true);
    expect(parsed.diagnostics.some((d: { message: string }) => d.message.includes("program:CALC-TAX"))).toBe(true);
  });

  it("code_parse persists field-lineage artifacts and wiki summary when copybooks are shared", async () => {
    const copybook = `
       01  CUSTOMER-REC.
           05  CUSTOMER-ID       PIC X(10).
           05  CUSTOMER-ADDRESS.
               10  ZIP-CODE      PIC 9(5).
`;
    const orderA = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ORDERA.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY CUSTOMER-REC.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;
    const orderB = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ORDERB.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY CUSTOMER-REC.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;

    wiki.rawAdd("ORDERA.cbl", { content: orderA });
    wiki.rawAdd("ORDERB.cbl", { content: orderB });
    wiki.rawAdd("CUSTOMER-REC.cpy", { content: copybook });

    await handleTool(wiki, "code_parse", { path: "ORDERA.cbl" });
    await handleTool(wiki, "code_parse", { path: "ORDERB.cbl" });
    const result = await handleTool(wiki, "code_parse", { path: "CUSTOMER-REC.cpy" });
    const parsed = JSON.parse(result as string);

    expect(parsed.artifacts).toContain("raw/parsed/cobol/field-lineage.json");
    expect(parsed.wikiPages).toContain("cobol/field-lineage.md");

    const lineagePath = join(tmp, "raw", "parsed", "cobol", "field-lineage.json");
    const pagePath = join(tmp, "wiki", "cobol", "field-lineage.md");
    expect(existsSync(lineagePath)).toBe(true);
    expect(existsSync(pagePath)).toBe(true);

    const lineage = JSON.parse(readFileSync(lineagePath, "utf-8"));
    expect(lineage.summary.deterministic.fields).toBeGreaterThan(0);
    expect(lineage.deterministic.some((entry: { fieldName: string }) => entry.fieldName === "ZIP-CODE")).toBe(true);
    expect(readFileSync(pagePath, "utf-8")).toContain("CUSTOMER-REC");
  });

  it("code_query field_lineage returns deterministic matches for a shared copybook field", async () => {
    const copybook = `
       01  CUSTOMER-REC.
           05  CUSTOMER-ID       PIC X(10).
`;
    const orderA = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ORDERA.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY CUSTOMER-REC.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;
    const orderB = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ORDERB.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY CUSTOMER-REC.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;

    wiki.rawAdd("ORDERA.cbl", { content: orderA });
    wiki.rawAdd("ORDERB.cbl", { content: orderB });
    wiki.rawAdd("CUSTOMER-REC.cpy", { content: copybook });

    await handleTool(wiki, "code_parse", { path: "ORDERA.cbl" });
    await handleTool(wiki, "code_parse", { path: "ORDERB.cbl" });
    await handleTool(wiki, "code_parse", { path: "CUSTOMER-REC.cpy" });

    const result = await handleTool(wiki, "code_query", {
      query_type: "field_lineage",
      field_name: "CUSTOMER-ID",
      copybook: "CUSTOMER-REC",
    });
    const parsed = JSON.parse(result as string);

    expect(parsed.query.type).toBe("field_lineage");
    expect(parsed.summary.deterministicMatches).toBeGreaterThan(0);
    expect(parsed.deterministic).toHaveLength(1);
    expect(parsed.deterministic[0].fieldName).toBe("CUSTOMER-ID");
    expect(parsed.deterministic[0].programs.map((program: { id: string }) => program.id)).toEqual([
      "program:ORDERA",
      "program:ORDERB",
    ]);
  });

  it("code_parse persists inferred field-lineage artifacts for cross-copybook matches", async () => {
    const customerA = `
       01  CUSTOMER-REC.
           05  CUSTOMER-ID       PIC X(10).
           05  CUSTOMER-NAME     PIC X(30).
`;
    const customerB = `
       01  CLIENT-REC.
           05  CUSTOMER-ID       PIC X(10).
           05  CUSTOMER-NAME     PIC X(30).
`;
    const billingA = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. BILLINGA.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY CUSTOMER-A.
       PROCEDURE DIVISION.
       MAIN.
           STOP RUN.
`;
    const billingB = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. BILLINGB.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY CUSTOMER-B.
       PROCEDURE DIVISION.
       MAIN.
           STOP RUN.
`;

    wiki.rawAdd("CUSTOMER-A.cpy", { content: customerA });
    wiki.rawAdd("CUSTOMER-B.cpy", { content: customerB });
    wiki.rawAdd("BILLINGA.cbl", { content: billingA });
    wiki.rawAdd("BILLINGB.cbl", { content: billingB });

    await handleTool(wiki, "code_parse", { path: "BILLINGA.cbl" });
    await handleTool(wiki, "code_parse", { path: "BILLINGB.cbl" });
    await handleTool(wiki, "code_parse", { path: "CUSTOMER-A.cpy" });
    const result = await handleTool(wiki, "code_parse", { path: "CUSTOMER-B.cpy" });
    const parsed = JSON.parse(result as string);

    expect(parsed.artifacts).toContain("raw/parsed/cobol/field-lineage.json");
    expect(parsed.wikiPages).toContain("cobol/field-lineage.md");

    const lineagePath = join(tmp, "raw", "parsed", "cobol", "field-lineage.json");
    const pagePath = join(tmp, "wiki", "cobol", "field-lineage.md");
    const lineage = JSON.parse(readFileSync(lineagePath, "utf-8"));
    expect(lineage.summary.deterministic.fields).toBe(0);
    expect(lineage.summary.inferred.highConfidence).toBeGreaterThan(0);
    expect(lineage.summary.inferred.copybooks).toBe(2);
    expect(lineage.summary.inferred.programs).toBe(2);
    expect(lineage.inferredHighConfidence.some((entry: { fieldName: string }) => entry.fieldName === "CUSTOMER-ID")).toBe(true);
    expect(readFileSync(pagePath, "utf-8")).toContain("Inferred Cross-Copybook Candidates");
  });

  it("code_parse persists DB2 references into model artifacts and wiki summaries", async () => {
    const source = readFileSync(join(FIXTURES, "CUSTOMER-DB2.cbl"), "utf-8");
    wiki.rawAdd("CUSTOMER-DB2.cbl", { content: source });

    const result = await handleTool(wiki, "code_parse", { path: "CUSTOMER-DB2.cbl" });
    const parsed = JSON.parse(result as string);

    expect(parsed.artifacts).toContain("raw/parsed/cobol/CUSTOMER-DB2.model.json");
    expect(parsed.wikiPages).toContain("cobol/programs/customerdb.md");

    const modelPath = join(tmp, "raw", "parsed", "cobol", "CUSTOMER-DB2.model.json");
    const pagePath = join(tmp, "wiki", "cobol", "programs", "customerdb.md");
    const modelJson = JSON.parse(readFileSync(modelPath, "utf-8"));
    expect(modelJson.db2References).toHaveLength(1);
    expect(modelJson.db2References[0].tables).toEqual(["CUSTOMER_STATUS", "CUSTOMER_TABLE"]);
    expect(readFileSync(pagePath, "utf-8")).toContain("### DB2");
    expect(readFileSync(pagePath, "utf-8")).toContain("CUSTOMER_TABLE");
  });

  it("code_parse persists CICS references into model artifacts and wiki summaries", async () => {
    const source = readFileSync(join(FIXTURES, "ONLINE-CICS.cbl"), "utf-8");
    wiki.rawAdd("ONLINE-CICS.cbl", { content: source });

    const result = await handleTool(wiki, "code_parse", { path: "ONLINE-CICS.cbl" });
    const parsed = JSON.parse(result as string);

    expect(parsed.artifacts).toContain("raw/parsed/cobol/ONLINE-CICS.model.json");
    expect(parsed.wikiPages).toContain("cobol/programs/onlinesvc.md");

    const modelPath = join(tmp, "raw", "parsed", "cobol", "ONLINE-CICS.model.json");
    const pagePath = join(tmp, "wiki", "cobol", "programs", "onlinesvc.md");
    const modelJson = JSON.parse(readFileSync(modelPath, "utf-8"));
    expect(modelJson.cicsReferences).toHaveLength(1);
    expect(modelJson.cicsReferences[0]).toMatchObject({
      command: "LINK",
      program: "CUSTSRV",
      transaction: "C001",
      map: "CUSTMAP",
    });
    expect(readFileSync(pagePath, "utf-8")).toContain("### CICS");
    expect(readFileSync(pagePath, "utf-8")).toContain("CUSTSRV");
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

  it("code_impact fails clearly when no compiled graph exists", async () => {
    await expect(handleTool(wiki, "code_impact", { node_id: "program:PAYROLL" }))
      .rejects.toThrow(/Compiled knowledge graph not found/);
  });

  it("code_impact does not include diagnostics for prefix-overlapping node ids", async () => {
    wiki.rawAddParsedArtifact("parsed/cobol/knowledge-graph.json", JSON.stringify({
      nodes: [
        { id: "program:PAY", kind: "Program", resolved: true, sourceFile: "PAY.cbl" },
        { id: "program:PAYROLL", kind: "Program", resolved: true, sourceFile: "PAYROLL.cbl" },
      ],
      edges: [],
      diagnostics: [
        {
          severity: "warning",
          message: 'Unresolved Program "program:PAYROLL" — referenced by [program:INVOICE] but never parsed from source',
          sourceFile: "INVOICE.cbl",
          line: 15,
        },
      ],
    }, null, 2));

    const result = await handleTool(wiki, "code_impact", { node_id: "program:PAY" });
    const parsed = JSON.parse(result as string);

    expect(parsed.source.node_id).toBe("program:PAY");
    expect(parsed.diagnostics).toEqual([]);
  });

  it("code_impact keeps diagnostics for dataset ids with dots and underscores", async () => {
    wiki.rawAddParsedArtifact("parsed/cobol/knowledge-graph.json", JSON.stringify({
      nodes: [
        { id: "dataset:HLQ.PROD_TRANS.FILE", kind: "Dataset", resolved: true, sourceFile: "JOB001.jcl" },
      ],
      edges: [],
      diagnostics: [
        {
          severity: "warning",
          message: 'Unresolved Dataset "dataset:HLQ.PROD_TRANS.FILE" — referenced by [program:PAYROLL] but never parsed from source',
          sourceFile: "PAYROLL.cbl",
          line: 27,
        },
      ],
    }, null, 2));

    const result = await handleTool(wiki, "code_impact", { node_id: "dataset:HLQ.PROD_TRANS.FILE" });
    const parsed = JSON.parse(result as string);

    expect(parsed.source.node_id).toBe("dataset:HLQ.PROD_TRANS.FILE");
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0].message).toContain("dataset:HLQ.PROD_TRANS.FILE");
  });

  it("code_parse and code_impact work for nested source paths", async () => {
    const source = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
    wiki.rawAdd("nested/PAYROLL.cbl", { content: source });

    const parseResult = await handleTool(wiki, "code_parse", { path: "nested/PAYROLL.cbl" });
    const parseParsed = JSON.parse(parseResult as string);
    expect(parseParsed.knowledgeGraph).toBeDefined();
    expect(parseParsed.knowledgeGraph.nodes).toBeGreaterThan(0);

    const impactResult = await handleTool(wiki, "code_impact", { node_id: "program:CALC-TAX" });
    const impactParsed = JSON.parse(impactResult as string);
    expect(impactParsed.impactedByDepth[0].nodes.some((n: { node_id: string }) => n.node_id === "program:PAYROLL")).toBe(true);
  });

  it("code_parse and code_query procedure_flow work for nested source paths", async () => {
    const source = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
    wiki.rawAdd("nested/PAYROLL.cbl", { content: source });

    await handleTool(wiki, "code_parse", { path: "nested/PAYROLL.cbl" });

    const result = await handleTool(wiki, "code_query", {
      query_type: "procedure_flow",
      path: "nested/PAYROLL.cbl",
      procedure: "A100-INIT",
    });
    const parsed = JSON.parse(result as string);

    expect(parsed.query.path).toBe("nested/PAYROLL.cbl");
    expect(parsed.flowByDepth[0].nodes.some((node: { name: string }) => node.name === "B000-PROCESS")).toBe(true);
  });

  it("wiki_rebuild emits deterministic call-graph source order for nested models", async () => {
    const payrollSrc = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
    const invoiceSrc = readFileSync(join(FIXTURES, "INVOICE.cbl"), "utf-8");
    wiki.rawAdd("nested/PAYROLL.cbl", { content: payrollSrc });
    wiki.rawAdd("INVOICE.cbl", { content: invoiceSrc });

    await handleTool(wiki, "code_parse", { path: "nested/PAYROLL.cbl" }, { skipGraphRebuild: true });
    await handleTool(wiki, "code_parse", { path: "INVOICE.cbl" }, { skipGraphRebuild: true });
    await handleTool(wiki, "wiki_rebuild", {});

    const callGraph = readFileSync(join(tmp, "wiki", "cobol", "call-graph.md"), "utf-8");
    const invoiceIdx = callGraph.indexOf("  - raw/INVOICE.cbl");
    const nestedIdx = callGraph.indexOf("  - raw/nested/PAYROLL.cbl");
    expect(invoiceIdx).toBeGreaterThan(-1);
    expect(nestedIdx).toBeGreaterThan(-1);
    expect(invoiceIdx).toBeLessThan(nestedIdx);
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

    it("batch code_parse followed by code_impact sees freshly rebuilt graph", async () => {
      const payrollSrc = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
      wiki.rawAdd("PAYROLL.cbl", { content: payrollSrc });

      const result = await handleTool(wiki, "batch", {
        operations: [
          { tool: "code_parse", args: { path: "PAYROLL.cbl" } },
          { tool: "code_impact", args: { node_id: "program:CALC-TAX" } },
        ],
      });
      const batch = JSON.parse(result as string);

      expect(batch.count).toBe(2);
      expect(batch.results[0].error).toBeUndefined();
      expect(batch.results[1].error).toBeUndefined();
      expect(batch.results[1].result.source.node_id).toBe("program:CALC-TAX");
      expect(batch.results[1].result.impactedByDepth).toHaveLength(1);
      expect(batch.results[1].result.impactedByDepth[0].nodes.some((n: { node_id: string }) => n.node_id === "program:PAYROLL")).toBe(true);

      const graphPath = join(tmp, "raw", "parsed", "cobol", "knowledge-graph.json");
      expect(existsSync(graphPath)).toBe(true);
    });

    it("batch code_parse followed by code_query field_lineage sees freshly rebuilt derived artifacts", async () => {
      const copybook = `
       01  CUSTOMER-REC.
           05  CUSTOMER-ID       PIC X(10).
`;
      const orderA = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ORDERA.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY CUSTOMER-REC.
       PROCEDURE DIVISION.
       MAIN.
           STOP RUN.
`;
      const orderB = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ORDERB.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY CUSTOMER-REC.
       PROCEDURE DIVISION.
       MAIN.
           STOP RUN.
`;

      wiki.rawAdd("ORDERA.cbl", { content: orderA });
      wiki.rawAdd("ORDERB.cbl", { content: orderB });
      wiki.rawAdd("CUSTOMER-REC.cpy", { content: copybook });

      const result = await handleTool(wiki, "batch", {
        operations: [
          { tool: "code_parse", args: { path: "ORDERA.cbl" } },
          { tool: "code_parse", args: { path: "ORDERB.cbl" } },
          { tool: "code_parse", args: { path: "CUSTOMER-REC.cpy" } },
          { tool: "code_query", args: { query_type: "field_lineage", field_name: "CUSTOMER-ID" } },
        ],
      });
      const batch = JSON.parse(result as string);

      expect(batch.results[3].error).toBeUndefined();
      expect(batch.results[3].result.summary.deterministicMatches).toBeGreaterThan(0);
      expect(batch.results[3].result.deterministic[0].fieldName).toBe("CUSTOMER-ID");

      const lineagePath = join(tmp, "raw", "parsed", "cobol", "field-lineage.json");
      expect(existsSync(lineagePath)).toBe(true);
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

    it("wiki_rebuild regenerates field-lineage artifacts from existing parsed models", async () => {
      const copybook = `
       01  CUSTOMER-REC.
           05  CUSTOMER-ID       PIC X(10).
`;
      const orderA = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ORDERA.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY CUSTOMER-REC.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;
      const orderB = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ORDERB.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY CUSTOMER-REC.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;

      wiki.rawAdd("ORDERA.cbl", { content: orderA });
      wiki.rawAdd("ORDERB.cbl", { content: orderB });
      wiki.rawAdd("CUSTOMER-REC.cpy", { content: copybook });

      await handleTool(wiki, "code_parse", { path: "ORDERA.cbl" }, { skipGraphRebuild: true });
      await handleTool(wiki, "code_parse", { path: "ORDERB.cbl" }, { skipGraphRebuild: true });
      await handleTool(wiki, "code_parse", { path: "CUSTOMER-REC.cpy" }, { skipGraphRebuild: true });

      const lineagePath = join(tmp, "raw", "parsed", "cobol", "field-lineage.json");
      const pagePath = join(tmp, "wiki", "cobol", "field-lineage.md");
      expect(existsSync(lineagePath)).toBe(false);
      expect(existsSync(pagePath)).toBe(false);

      await handleTool(wiki, "wiki_rebuild", {});

      expect(existsSync(lineagePath)).toBe(true);
      expect(existsSync(pagePath)).toBe(true);
      const lineage = JSON.parse(readFileSync(lineagePath, "utf-8"));
      expect(lineage.summary.deterministic.fields).toBeGreaterThan(0);
    });

    it("wiki_rebuild removes stale field-lineage outputs when lineage no longer exists", async () => {
      const copybook = `
       01  CUSTOMER-REC.
           05  CUSTOMER-ID       PIC X(10).
`;
      const orderA = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ORDERA.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY CUSTOMER-REC.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;
      const orderB = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ORDERB.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY CUSTOMER-REC.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;

      wiki.rawAdd("ORDERA.cbl", { content: orderA });
      wiki.rawAdd("ORDERB.cbl", { content: orderB });
      wiki.rawAdd("CUSTOMER-REC.cpy", { content: copybook });

      await handleTool(wiki, "code_parse", { path: "ORDERA.cbl" }, { skipGraphRebuild: true });
      await handleTool(wiki, "code_parse", { path: "ORDERB.cbl" }, { skipGraphRebuild: true });
      await handleTool(wiki, "code_parse", { path: "CUSTOMER-REC.cpy" }, { skipGraphRebuild: true });
      await handleTool(wiki, "wiki_rebuild", {});

      const lineagePath = join(tmp, "raw", "parsed", "cobol", "field-lineage.json");
      const lineageMetaPath = `${lineagePath}.meta.yaml`;
      const pagePath = join(tmp, "wiki", "cobol", "field-lineage.md");
      expect(existsSync(lineagePath)).toBe(true);
      expect(existsSync(pagePath)).toBe(true);

      rmSync(join(tmp, "raw", "parsed", "cobol", "ORDERB.model.json"), { force: true });
      rmSync(join(tmp, "raw", "parsed", "cobol", "ORDERB.model.json.meta.yaml"), { force: true });

      await handleTool(wiki, "wiki_rebuild", {});

      expect(existsSync(lineagePath)).toBe(false);
      expect(existsSync(lineageMetaPath)).toBe(false);
      expect(existsSync(pagePath)).toBe(false);
    });

    it("wiki_rebuild removes stale field-lineage outputs when parsed model directory disappears", async () => {
      const copybook = `
       01  CUSTOMER-REC.
           05  CUSTOMER-ID       PIC X(10).
`;
      const orderA = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ORDERA.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY CUSTOMER-REC.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;
      const orderB = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ORDERB.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY CUSTOMER-REC.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           STOP RUN.
`;

      wiki.rawAdd("ORDERA.cbl", { content: orderA });
      wiki.rawAdd("ORDERB.cbl", { content: orderB });
      wiki.rawAdd("CUSTOMER-REC.cpy", { content: copybook });

      await handleTool(wiki, "code_parse", { path: "ORDERA.cbl" }, { skipGraphRebuild: true });
      await handleTool(wiki, "code_parse", { path: "ORDERB.cbl" }, { skipGraphRebuild: true });
      await handleTool(wiki, "code_parse", { path: "CUSTOMER-REC.cpy" }, { skipGraphRebuild: true });
      await handleTool(wiki, "wiki_rebuild", {});

      const lineagePath = join(tmp, "raw", "parsed", "cobol", "field-lineage.json");
      const lineageMetaPath = `${lineagePath}.meta.yaml`;
      const pagePath = join(tmp, "wiki", "cobol", "field-lineage.md");
      expect(existsSync(lineagePath)).toBe(true);
      expect(existsSync(pagePath)).toBe(true);

      rmSync(join(tmp, "raw", "parsed", "cobol"), { recursive: true, force: true });

      await handleTool(wiki, "wiki_rebuild", {});

      expect(existsSync(lineagePath)).toBe(false);
      expect(existsSync(lineageMetaPath)).toBe(false);
      expect(existsSync(pagePath)).toBe(false);
    });

    it("wiki_rebuild includes graph pages in index.md and timeline.md", async () => {
      const payrollSrc = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
      wiki.rawAdd("PAYROLL.cbl", { content: payrollSrc });

      // Parse with graph rebuild skipped — no graph pages yet
      await handleTool(wiki, "code_parse", { path: "PAYROLL.cbl" }, { skipGraphRebuild: true });
      expect(existsSync(join(tmp, "wiki", "cobol", "system-map.md"))).toBe(false);
      expect(existsSync(join(tmp, "wiki", "cobol", "call-graph.md"))).toBe(false);

      // Single wiki_rebuild should generate graph pages AND include them in index/timeline
      await handleTool(wiki, "wiki_rebuild", {});

      // Graph pages exist
      expect(existsSync(join(tmp, "wiki", "cobol", "system-map.md"))).toBe(true);
      expect(existsSync(join(tmp, "wiki", "cobol", "call-graph.md"))).toBe(true);

      // Graph pages are under cobol/, so they appear in the topic sub-index
      const cobolIndex = readFileSync(join(tmp, "wiki", "cobol", "index.md"), "utf-8");
      expect(cobolIndex).toContain("system-map");
      expect(cobolIndex).toContain("call-graph");
      // Top-level index should reference the cobol topic
      const index = readFileSync(join(tmp, "wiki", "index.md"), "utf-8");
      expect(index).toContain("cobol");

      // Timeline includes the freshly generated graph pages
      const timeline = readFileSync(join(tmp, "wiki", "timeline.md"), "utf-8");
      expect(timeline).toContain("COBOL System Map");
      expect(timeline).toContain("COBOL Call Graph");
    });

    it("batch code_parse rebuilds timeline with graph pages", async () => {
      const payrollSrc = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
      wiki.rawAdd("PAYROLL.cbl", { content: payrollSrc });

      // Batch with a single code_parse — deferred graph rebuild should trigger timeline
      const batchOps = [{ tool: "code_parse", args: { path: "PAYROLL.cbl" } }];
      await handleTool(wiki, "batch", { operations: batchOps });

      // Graph pages exist
      expect(existsSync(join(tmp, "wiki", "cobol", "system-map.md"))).toBe(true);
      expect(existsSync(join(tmp, "wiki", "cobol", "call-graph.md"))).toBe(true);

      // Index includes graph pages
      const index = readFileSync(join(tmp, "wiki", "index.md"), "utf-8");
      expect(index).toContain("cobol");

      // Timeline includes graph pages — this is the regression test
      const timeline = readFileSync(join(tmp, "wiki", "timeline.md"), "utf-8");
      expect(timeline).toContain("COBOL System Map");
      expect(timeline).toContain("COBOL Call Graph");
    });
  });

  describe("dataflow_edges", () => {
    it("returns flat edge list for a parsed program", async () => {
      const source = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
      wiki.rawAdd("PAYROLL.cbl", { content: source });
      await handleTool(wiki, "code_parse", { path: "PAYROLL.cbl" });

      const result = await handleTool(wiki, "code_query", {
        query_type: "dataflow_edges",
        path: "PAYROLL.cbl",
      });
      const parsed = JSON.parse(result as string);

      expect(parsed.total).toBeGreaterThan(0);
      const addEdge = parsed.edges.find((e: { from: string; to: string; via: string }) =>
        e.from === "EMP-SALARY" && e.to === "WS-TOTAL-SALARY" && e.via === "ADD"
      );
      expect(addEdge).toBeDefined();
    });

    it("filters by from field", async () => {
      const source = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
      wiki.rawAdd("PAYROLL.cbl", { content: source });
      await handleTool(wiki, "code_parse", { path: "PAYROLL.cbl" });

      const result = await handleTool(wiki, "code_query", {
        query_type: "dataflow_edges",
        path: "PAYROLL.cbl",
        from: "EMP-SALARY",
      });
      const parsed = JSON.parse(result as string);

      expect(parsed.edges.every((e: { from: string }) => e.from === "EMP-SALARY")).toBe(true);
    });

    it("transitive downstream: EMP-SALARY reaches WS-AVG-SALARY via WS-TOTAL-SALARY", async () => {
      const source = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
      wiki.rawAdd("PAYROLL.cbl", { content: source });
      await handleTool(wiki, "code_parse", { path: "PAYROLL.cbl" });

      const result = await handleTool(wiki, "code_query", {
        query_type: "dataflow_edges",
        path: "PAYROLL.cbl",
        field: "EMP-SALARY",
        transitive: true,
        direction: "downstream",
      });
      const parsed = JSON.parse(result as string);

      expect(parsed.transitive).toBe(true);
      expect(parsed.field).toBe("EMP-SALARY");
      expect(parsed.direction).toBe("downstream");

      const allFields = parsed.levels.flatMap((l: { fields: string[] }) => l.fields);
      expect(allFields).toContain("WS-TOTAL-SALARY");
      expect(allFields).toContain("WS-AVG-SALARY");
    });

    it("transitive upstream: WS-AVG-SALARY traces back to EMP-SALARY", async () => {
      const source = readFileSync(join(FIXTURES, "PAYROLL.cbl"), "utf-8");
      wiki.rawAdd("PAYROLL.cbl", { content: source });
      await handleTool(wiki, "code_parse", { path: "PAYROLL.cbl" });

      const result = await handleTool(wiki, "code_query", {
        query_type: "dataflow_edges",
        path: "PAYROLL.cbl",
        field: "WS-AVG-SALARY",
        transitive: true,
        direction: "upstream",
      });
      const parsed = JSON.parse(result as string);

      const allFields = parsed.levels.flatMap((l: { fields: string[] }) => l.fields);
      expect(allFields).toContain("WS-TOTAL-SALARY");
      expect(allFields).toContain("EMP-SALARY");
    });
  });
});
