import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "../parser.js";
import { extractModel } from "../extractors.js";
import {
  KnowledgeGraphBuilder,
  populateGraphFromCobol,
  canonicalNodeId,
  resolveCanonicalId,
  displayLabel,
  serializeGraph,
  deserializeGraph,
  toMermaid,
  toDot,
} from "../graph.js";
import type { ConfidenceLevel, GraphEdge, GraphNode } from "../graph.js";

const FIXTURES = resolve(process.cwd(), "src/cobol/__tests__/fixtures");
const fixture = (name: string) => readFileSync(resolve(FIXTURES, name), "utf-8");

// ---------------------------------------------------------------------------
// Helper: parse + extract model
// ---------------------------------------------------------------------------

function modelFor(name: string) {
  const ast = parse(fixture(name), name);
  return extractModel(ast);
}

// ---------------------------------------------------------------------------
// canonicalNodeId / displayLabel
// ---------------------------------------------------------------------------

describe("canonicalNodeId / displayLabel", () => {
  it("creates namespaced IDs", () => {
    expect(canonicalNodeId("Program", "PAYROLL")).toBe("program:PAYROLL");
    expect(canonicalNodeId("Copybook", "DATE-UTILS")).toBe("copybook:DATE-UTILS");
    expect(canonicalNodeId("Dataset", "EMP-FILE")).toBe("dataset:EMP-FILE");
    expect(canonicalNodeId("Job", "NIGHTLY")).toBe("job:NIGHTLY");
    expect(canonicalNodeId("Step", "STEP01")).toBe("step:STEP01");
  });

  it("extracts display label from canonical ID", () => {
    expect(displayLabel("program:PAYROLL")).toBe("PAYROLL");
    expect(displayLabel("copybook:DATE-UTILS")).toBe("DATE-UTILS");
    expect(displayLabel("BARE-NAME")).toBe("BARE-NAME");
  });

  it("strips directory components when deriving logical ids from source paths", () => {
    expect(resolveCanonicalId({ programId: "", sourceFile: "nested/DATE-UTILS.cpy" })).toBe("DATE-UTILS");
    expect(resolveCanonicalId({ programId: "", sourceFile: "src/legacy/PAYROLL.cbl" })).toBe("PAYROLL");
  });
});

// ---------------------------------------------------------------------------
// Builder basics
// ---------------------------------------------------------------------------

describe("KnowledgeGraphBuilder", () => {
  it("adds and retrieves nodes", () => {
    const b = new KnowledgeGraphBuilder();
    b.addNode({ id: "program:PROG1", kind: "Program", sourceFile: "PROG1.cbl" });
    expect(b.hasNode("program:PROG1")).toBe(true);
    expect(b.getNode("program:PROG1")?.kind).toBe("Program");
  });

  it("merges metadata on duplicate node add", () => {
    const b = new KnowledgeGraphBuilder();
    b.addNode({ id: "program:PROG1", kind: "Program", metadata: { a: 1 } });
    b.addNode({ id: "program:PROG1", kind: "Program", metadata: { b: 2 } });
    expect(b.getNode("program:PROG1")?.metadata).toEqual({ a: 1, b: 2 });
  });

  it("adds edges and queries by direction", () => {
    const b = new KnowledgeGraphBuilder();
    b.addNode({ id: "program:A", kind: "Program" });
    b.addNode({ id: "program:B", kind: "Program" });
    b.addEdge({
      from: "program:A", to: "program:B", kind: "CALLS",
      confidence: "deterministic",
      evidence: { sourceFile: "A.cbl", line: 10 },
    });

    expect(b.edgesFrom("program:A").length).toBe(1);
    expect(b.edgesTo("program:B").length).toBe(1);
    expect(b.edgesFrom("program:B").length).toBe(0);
  });

  it("validates edges on build — warns about unknown and unresolved nodes", () => {
    const b = new KnowledgeGraphBuilder();
    b.addNode({ id: "program:A", kind: "Program", resolved: true });
    b.addEdge({
      from: "program:A", to: "program:UNKNOWN",
      kind: "CALLS",
      confidence: "inferred-low",
      evidence: { sourceFile: "A.cbl", line: 5 },
    });

    const graph = b.build();
    expect(graph.diagnostics.length).toBeGreaterThanOrEqual(1);
    const msgs = graph.diagnostics.map((d) => d.message);
    expect(msgs.some((m) => m.includes("UNKNOWN"))).toBe(true);
  });

  it("build is idempotent and does not duplicate validation diagnostics", () => {
    const b = new KnowledgeGraphBuilder();
    b.addNode({ id: "program:A", kind: "Program", resolved: true });
    b.addEdge({
      from: "program:A", to: "program:UNKNOWN",
      kind: "CALLS",
      confidence: "deterministic",
      evidence: { sourceFile: "A.cbl", line: 5 },
    });

    const first = b.build();
    const second = b.build();
    expect(second.diagnostics).toEqual(first.diagnostics);
    expect(second.diagnostics).toHaveLength(first.diagnostics.length);
  });

  it("computes dependentsOf and dependenciesOf", () => {
    const b = new KnowledgeGraphBuilder();
    b.addNode({ id: "program:A", kind: "Program" });
    b.addNode({ id: "program:B", kind: "Program" });
    b.addNode({ id: "copybook:C", kind: "Copybook" });
    b.addEdge({
      from: "program:A", to: "program:B", kind: "CALLS",
      confidence: "deterministic",
      evidence: { sourceFile: "A.cbl", line: 10 },
    });
    b.addEdge({
      from: "program:A", to: "copybook:C", kind: "COPIES",
      confidence: "deterministic",
      evidence: { sourceFile: "A.cbl", line: 20 },
    });

    const deps = b.dependenciesOf("program:A");
    expect(deps.map((n) => n.id).sort()).toEqual(["copybook:C", "program:B"]);

    const dependents = b.dependentsOf("program:B");
    expect(dependents.map((n) => n.id)).toEqual(["program:A"]);
  });

  it("computes transitive impact analysis", () => {
    const b = new KnowledgeGraphBuilder();
    b.addNode({ id: "copybook:CPY", kind: "Copybook" });
    b.addNode({ id: "program:PROG1", kind: "Program" });
    b.addNode({ id: "program:PROG2", kind: "Program" });
    b.addNode({ id: "program:PROG3", kind: "Program" });

    b.addEdge({
      from: "program:PROG1", to: "copybook:CPY", kind: "COPIES",
      confidence: "deterministic",
      evidence: { sourceFile: "PROG1.cbl", line: 5 },
    });
    b.addEdge({
      from: "program:PROG2", to: "copybook:CPY", kind: "COPIES",
      confidence: "deterministic",
      evidence: { sourceFile: "PROG2.cbl", line: 5 },
    });
    b.addEdge({
      from: "program:PROG3", to: "program:PROG1", kind: "CALLS",
      confidence: "deterministic",
      evidence: { sourceFile: "PROG3.cbl", line: 10 },
    });

    const impact = b.impactOf("copybook:CPY");
    expect(impact.get(1)?.map((n) => n.id).sort()).toEqual(["program:PROG1", "program:PROG2"]);
    expect(impact.get(2)?.map((n) => n.id)).toEqual(["program:PROG3"]);
  });

  it("respects maxDepth when traversing impact", () => {
    const b = new KnowledgeGraphBuilder();
    b.addNode({ id: "copybook:CPY", kind: "Copybook" });
    b.addNode({ id: "program:PROG1", kind: "Program" });
    b.addNode({ id: "program:PROG2", kind: "Program" });

    b.addEdge({
      from: "program:PROG1", to: "copybook:CPY", kind: "COPIES",
      confidence: "deterministic",
      evidence: { sourceFile: "PROG1.cbl", line: 5 },
    });
    b.addEdge({
      from: "program:PROG2", to: "program:PROG1", kind: "CALLS",
      confidence: "deterministic",
      evidence: { sourceFile: "PROG2.cbl", line: 10 },
    });

    const shallow = b.impactOf("copybook:CPY", 1);
    expect(shallow.get(1)?.map((n) => n.id)).toEqual(["program:PROG1"]);
    expect(shallow.get(2)).toBeUndefined();

    const deep = b.impactOf("copybook:CPY", 2);
    expect(deep.get(1)?.map((n) => n.id)).toEqual(["program:PROG1"]);
    expect(deep.get(2)?.map((n) => n.id)).toEqual(["program:PROG2"]);
  });
});

// ---------------------------------------------------------------------------
// COBOL → Graph population (namespaced IDs)
// ---------------------------------------------------------------------------

describe("populateGraphFromCobol", () => {
  it("creates Program node with namespaced ID from PAYROLL.cbl", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [modelFor("PAYROLL.cbl")]);
    const graph = builder.build();

    expect(graph.nodes.has("program:PAYROLL")).toBe(true);
    expect(graph.nodes.get("program:PAYROLL")?.kind).toBe("Program");
    expect(graph.nodes.get("program:PAYROLL")?.resolved).toBe(true);
  });

  it("creates CALLS edges with namespaced IDs", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [modelFor("PAYROLL.cbl")]);
    const graph = builder.build();

    const calls = graph.edges.filter((e) => e.kind === "CALLS");
    expect(calls.length).toBe(2);
    // All CALLS edges use namespaced IDs
    for (const c of calls) {
      expect(c.from).toBe("program:PAYROLL");
      expect(c.to.startsWith("program:")).toBe(true);
    }
  });

  it("creates COPIES edges with namespaced IDs from INVOICE", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [modelFor("INVOICE.cbl")]);
    const graph = builder.build();

    const copies = graph.edges.filter((e) => e.kind === "COPIES");
    expect(copies.length).toBeGreaterThanOrEqual(1);
    for (const c of copies) {
      expect(c.from).toBe("program:INVOICE");
      expect(c.to.startsWith("copybook:")).toBe(true);
    }
  });

  it("creates Dataset nodes with namespaced IDs", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [modelFor("PAYROLL.cbl")]);
    const graph = builder.build();

    expect(graph.nodes.has("dataset:EMPLOYEE-FILE")).toBe(true);
    const ds = graph.nodes.get("dataset:EMPLOYEE-FILE")!;
    expect(ds.kind).toBe("Dataset");
  });

  it("FD-backed Dataset nodes are resolved and emit no diagnostics", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [modelFor("PAYROLL.cbl")]);
    const graph = builder.build();

    // FD EMPLOYEE-FILE is extracted from parsed source → must be resolved
    const ds = graph.nodes.get("dataset:EMPLOYEE-FILE")!;
    expect(ds.resolved).toBe(true);

    // No unresolved-target diagnostic for FD-backed datasets
    const datasetDiags = graph.diagnostics.filter((d) =>
      d.message.toLowerCase().includes("employee-file")
    );
    expect(datasetDiags).toHaveLength(0);
  });

  it("creates Copybook node with canonical namespaced ID (no extension)", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [modelFor("DATE-UTILS.cpy")]);
    const graph = builder.build();

    // Canonical ID must be "copybook:DATE-UTILS", NOT "copybook:DATE-UTILS.cpy"
    expect(graph.nodes.has("copybook:DATE-UTILS")).toBe(true);
    expect(graph.nodes.has("copybook:DATE-UTILS.cpy")).toBe(false);
    // No bare "DATE-UTILS" node either
    expect(graph.nodes.has("DATE-UTILS")).toBe(false);

    const node = graph.nodes.get("copybook:DATE-UTILS")!;
    expect(node.kind).toBe("Copybook");
    expect(node.resolved).toBe(true);
    expect(node.sourceFile).toBe("DATE-UTILS.cpy");
  });
});

// ---------------------------------------------------------------------------
// P1: copybook identity — COPY ref and parsed .cpy merge into ONE node
// ---------------------------------------------------------------------------

describe("copybook identity merging", () => {
  it("nested .cpy path still resolves to the same canonical copybook node", () => {
    const nestedCopybook = {
      ...modelFor("DATE-UTILS.cpy"),
      sourceFile: "nested/DATE-UTILS.cpy",
    };
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [
      modelFor("INVOICE.cbl"),
      nestedCopybook,
    ]);
    const graph = builder.build();

    expect(graph.nodes.has("copybook:DATE-UTILS")).toBe(true);
    expect(graph.nodes.has("copybook:nested/DATE-UTILS")).toBe(false);
    const dateNodes = Array.from(graph.nodes.values()).filter((n) => n.id.includes("DATE-UTILS"));
    expect(dateNodes).toHaveLength(1);
    expect(dateNodes[0].id).toBe("copybook:DATE-UTILS");
    const copyEdge = graph.edges.find(
      (e) => e.from === "program:INVOICE" && e.to === "copybook:DATE-UTILS" && e.kind === "COPIES",
    );
    expect(copyEdge).toBeDefined();
  });

  it(".cpy parsed FIRST → COPY reference reuses the same node", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [
      modelFor("DATE-UTILS.cpy"),
      modelFor("INVOICE.cbl"),
    ]);
    const graph = builder.build();

    // Exactly ONE node for DATE-UTILS across the entire graph
    const dateNodes = Array.from(graph.nodes.values()).filter(
      (n) => n.id.includes("DATE-UTILS"),
    );
    expect(dateNodes.length).toBe(1);
    expect(dateNodes[0].id).toBe("copybook:DATE-UTILS");
    expect(dateNodes[0].resolved).toBe(true);
    expect(dateNodes[0].sourceFile).toBe("DATE-UTILS.cpy");

    // COPIES edge from INVOICE → same copybook node
    const copyEdge = graph.edges.find(
      (e) => e.from === "program:INVOICE" && e.to === "copybook:DATE-UTILS" && e.kind === "COPIES",
    );
    expect(copyEdge).toBeDefined();
  });

  it(".cbl parsed FIRST → placeholder gets promoted when .cpy is parsed", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [
      modelFor("INVOICE.cbl"),    // creates placeholder copybook:DATE-UTILS
      modelFor("DATE-UTILS.cpy"), // promotes to resolved
    ]);
    const graph = builder.build();

    const dateNodes = Array.from(graph.nodes.values()).filter(
      (n) => n.id.includes("DATE-UTILS"),
    );
    expect(dateNodes.length).toBe(1);
    expect(dateNodes[0].id).toBe("copybook:DATE-UTILS");
    expect(dateNodes[0].resolved).toBe(true);
    expect(dateNodes[0].sourceFile).toBe("DATE-UTILS.cpy");

    const copyEdge = graph.edges.find(
      (e) => e.from === "program:INVOICE" && e.to === "copybook:DATE-UTILS" && e.kind === "COPIES",
    );
    expect(copyEdge).toBeDefined();
  });

  it("multi-program graph: all COPIES edges target the same resolved copybook node", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [
      modelFor("HELLO.cbl"),
      modelFor("PAYROLL.cbl"),
      modelFor("INVOICE.cbl"),
      modelFor("DATE-UTILS.cpy"),
    ]);
    const graph = builder.build();

    // DATE-UTILS: exactly one node, resolved
    const dateNode = graph.nodes.get("copybook:DATE-UTILS");
    expect(dateNode).toBeDefined();
    expect(dateNode!.resolved).toBe(true);
    expect(dateNode!.sourceFile).toBe("DATE-UTILS.cpy");

    // No ghost nodes with .cpy extension or bare name
    expect(graph.nodes.has("copybook:DATE-UTILS.cpy")).toBe(false);
    expect(graph.nodes.has("DATE-UTILS")).toBe(false);

    // All COPIES edges targeting DATE-UTILS use the canonical namespaced ID
    const copyEdges = graph.edges.filter(
      (e) => e.to === "copybook:DATE-UTILS" && e.kind === "COPIES",
    );
    expect(copyEdges.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// P2: unresolved targets surface as diagnostics, not disguised normal nodes
// ---------------------------------------------------------------------------

describe("unresolved target diagnostics", () => {
  it("INVOICE.cbl alone — all external refs are unresolved with diagnostics", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [modelFor("INVOICE.cbl")]);
    const graph = builder.build();

    // External references: CALL "CALC-TOTAL", COPY DATE-UTILS, CUSTOMER-REC, LINK-PARAMS
    const unresolvedChecks = [
      { id: "program:CALC-TOTAL", kind: "Program" },
      { id: "copybook:DATE-UTILS", kind: "Copybook" },
      { id: "copybook:CUSTOMER-REC", kind: "Copybook" },
      { id: "copybook:LINK-PARAMS", kind: "Copybook" },
    ];

    for (const check of unresolvedChecks) {
      const node = graph.nodes.get(check.id);
      expect(node, `placeholder node "${check.id}" should exist`).toBeDefined();
      expect(node!.resolved, `"${check.id}" must be resolved=false`).toBe(false);
      expect(node!.sourceFile).toBeUndefined();
      expect(node!.kind).toBe(check.kind);
    }

    // INVOICE itself must be resolved
    expect(graph.nodes.get("program:INVOICE")?.resolved).toBe(true);

    // build() must emit diagnostics for every unresolved node
    const unresolvedDiags = graph.diagnostics.filter((d) =>
      d.message.startsWith("Unresolved"),
    );
    for (const check of unresolvedChecks) {
      const diag = unresolvedDiags.find((d) => d.message.includes(`"${check.id}"`));
      expect(diag, `diagnostic for "${check.id}" should exist`).toBeDefined();
      expect(diag!.message).toContain("program:INVOICE");  // referrer listed
      expect(diag!.sourceFile).toBe("INVOICE.cbl");
    }
  });

  it("parsing the source promotes placeholder → resolved, diagnostic disappears", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [modelFor("INVOICE.cbl")]);
    populateGraphFromCobol(builder, [modelFor("DATE-UTILS.cpy")]);
    const graph = builder.build();

    // DATE-UTILS promoted to resolved — no unresolved diagnostic
    expect(graph.nodes.get("copybook:DATE-UTILS")?.resolved).toBe(true);
    const dateUtilsDiag = graph.diagnostics.find(
      (d) => d.message.includes('"copybook:DATE-UTILS"') && d.message.startsWith("Unresolved"),
    );
    expect(dateUtilsDiag).toBeUndefined();

    // CALC-TOTAL, CUSTOMER-REC, LINK-PARAMS still unresolved
    for (const id of ["program:CALC-TOTAL", "copybook:CUSTOMER-REC", "copybook:LINK-PARAMS"]) {
      expect(graph.nodes.get(id)?.resolved).toBe(false);
      const diag = graph.diagnostics.find(
        (d) => d.message.includes(`"${id}"`) && d.message.startsWith("Unresolved"),
      );
      expect(diag, `"${id}" should still have unresolved diagnostic`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Impact analysis with mixed resolved/unresolved nodes
// ---------------------------------------------------------------------------

describe("impactOf with resolved and unresolved nodes", () => {
  it("traverses through resolved nodes and includes unresolved dependents", () => {
    const b = new KnowledgeGraphBuilder();
    b.addNode({ id: "copybook:CPY-SHARED", kind: "Copybook", resolved: true, sourceFile: "CPY-SHARED.cpy" });
    b.addNode({ id: "program:PROG-A", kind: "Program", resolved: true, sourceFile: "PROG-A.cbl" });
    b.addNode({ id: "program:PROG-B", kind: "Program", resolved: true, sourceFile: "PROG-B.cbl" });
    b.addNode({ id: "program:PROG-UNKNOWN", kind: "Program", resolved: false });

    b.addEdge({
      from: "program:PROG-A", to: "copybook:CPY-SHARED", kind: "COPIES",
      confidence: "deterministic",
      evidence: { sourceFile: "PROG-A.cbl", line: 5 },
    });
    b.addEdge({
      from: "program:PROG-UNKNOWN", to: "copybook:CPY-SHARED", kind: "COPIES",
      confidence: "inferred-low",
      evidence: { sourceFile: "external-ref.cbl", line: 3, reason: "inferred from naming" },
    });
    b.addEdge({
      from: "program:PROG-B", to: "program:PROG-A", kind: "CALLS",
      confidence: "deterministic",
      evidence: { sourceFile: "PROG-B.cbl", line: 20 },
    });

    const impact = b.impactOf("copybook:CPY-SHARED");

    const depth1 = impact.get(1)!;
    expect(depth1).toBeDefined();
    expect(depth1.map((n) => n.id).sort()).toEqual(["program:PROG-A", "program:PROG-UNKNOWN"]);

    const depth2 = impact.get(2)!;
    expect(depth2).toBeDefined();
    expect(depth2.map((n) => n.id)).toEqual(["program:PROG-B"]);

    // Consumers can filter by resolved status
    const unresolvedInImpact = depth1.filter((n) => !n.resolved);
    expect(unresolvedInImpact.length).toBe(1);
    expect(unresolvedInImpact[0].id).toBe("program:PROG-UNKNOWN");
  });

  it("real COBOL: impactOf copybook:DATE-UTILS includes program:INVOICE", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [
      modelFor("DATE-UTILS.cpy"),
      modelFor("INVOICE.cbl"),
    ]);

    const impact = builder.impactOf("copybook:DATE-UTILS");
    const depth1 = impact.get(1);
    expect(depth1).toBeDefined();
    expect(depth1!.some((n) => n.id === "program:INVOICE")).toBe(true);
    expect(depth1!.find((n) => n.id === "program:INVOICE")?.resolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe("graph serialization", () => {
  it("round-trips through JSON preserving namespaced IDs", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [modelFor("PAYROLL.cbl")]);
    const graph = builder.build();

    const serialized = serializeGraph(graph);
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json);
    const restored = deserializeGraph(parsed);

    expect(restored.nodes.size).toBe(graph.nodes.size);
    expect(restored.edges.length).toBe(graph.edges.length);
    expect(restored.nodes.get("program:PAYROLL")?.kind).toBe("Program");
    // Verify namespaced IDs survived round-trip
    for (const [id] of restored.nodes) {
      expect(id).toMatch(/^(program|copybook|dataset|job|step):/);
    }
  });
});

// ---------------------------------------------------------------------------
// Export formats
// ---------------------------------------------------------------------------

describe("graph export", () => {
  it("generates Mermaid with display labels (no namespace prefix in visuals)", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [
      modelFor("PAYROLL.cbl"),
      modelFor("HELLO.cbl"),
    ]);
    const graph = builder.build();
    const mermaid = toMermaid(graph);

    expect(mermaid).toContain("graph LR");
    // Display labels should not include "program:" prefix
    expect(mermaid).toContain("PAYROLL");
    expect(mermaid).toContain("-->");
  });

  it("generates DOT with display labels", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [modelFor("PAYROLL.cbl")]);
    const graph = builder.build();
    const dot = toDot(graph);

    expect(dot).toContain("digraph KnowledgeGraph");
    expect(dot).toContain("PAYROLL");
    expect(dot).toContain("->");
  });
});
