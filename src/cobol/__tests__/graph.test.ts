import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "../parser.js";
import { extractModel } from "../extractors.js";
import {
  KnowledgeGraphBuilder,
  populateGraphFromCobol,
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
// Builder basics
// ---------------------------------------------------------------------------

describe("KnowledgeGraphBuilder", () => {
  it("adds and retrieves nodes", () => {
    const b = new KnowledgeGraphBuilder();
    b.addNode({ id: "PROG1", kind: "Program", sourceFile: "PROG1.cbl" });
    expect(b.hasNode("PROG1")).toBe(true);
    expect(b.getNode("PROG1")?.kind).toBe("Program");
  });

  it("merges metadata on duplicate node add", () => {
    const b = new KnowledgeGraphBuilder();
    b.addNode({ id: "PROG1", kind: "Program", metadata: { a: 1 } });
    b.addNode({ id: "PROG1", kind: "Program", metadata: { b: 2 } });
    expect(b.getNode("PROG1")?.metadata).toEqual({ a: 1, b: 2 });
  });

  it("adds edges and queries by direction", () => {
    const b = new KnowledgeGraphBuilder();
    b.addNode({ id: "A", kind: "Program" });
    b.addNode({ id: "B", kind: "Program" });
    b.addEdge({
      from: "A", to: "B", kind: "CALLS",
      confidence: "deterministic",
      evidence: { sourceFile: "A.cbl", line: 10 },
    });

    expect(b.edgesFrom("A").length).toBe(1);
    expect(b.edgesTo("B").length).toBe(1);
    expect(b.edgesFrom("B").length).toBe(0);
  });

  it("validates edges on build — warns about unknown nodes", () => {
    const b = new KnowledgeGraphBuilder();
    b.addNode({ id: "A", kind: "Program" });
    b.addEdge({
      from: "A", to: "UNKNOWN",
      kind: "CALLS",
      confidence: "inferred-low",
      evidence: { sourceFile: "A.cbl", line: 5 },
    });

    const graph = b.build();
    expect(graph.diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(graph.diagnostics[0].message).toContain("UNKNOWN");
  });

  it("computes dependentsOf and dependenciesOf", () => {
    const b = new KnowledgeGraphBuilder();
    b.addNode({ id: "A", kind: "Program" });
    b.addNode({ id: "B", kind: "Program" });
    b.addNode({ id: "C", kind: "Copybook" });
    b.addEdge({
      from: "A", to: "B", kind: "CALLS",
      confidence: "deterministic",
      evidence: { sourceFile: "A.cbl", line: 10 },
    });
    b.addEdge({
      from: "A", to: "C", kind: "COPIES",
      confidence: "deterministic",
      evidence: { sourceFile: "A.cbl", line: 20 },
    });

    const deps = b.dependenciesOf("A");
    expect(deps.map((n) => n.id).sort()).toEqual(["B", "C"]);

    const dependents = b.dependentsOf("B");
    expect(dependents.map((n) => n.id)).toEqual(["A"]);
  });

  it("computes transitive impact analysis", () => {
    const b = new KnowledgeGraphBuilder();
    b.addNode({ id: "CPY", kind: "Copybook" });
    b.addNode({ id: "PROG1", kind: "Program" });
    b.addNode({ id: "PROG2", kind: "Program" });
    b.addNode({ id: "PROG3", kind: "Program" });

    // CPY <- PROG1, PROG2 (both copy it)
    b.addEdge({
      from: "PROG1", to: "CPY", kind: "COPIES",
      confidence: "deterministic",
      evidence: { sourceFile: "PROG1.cbl", line: 5 },
    });
    b.addEdge({
      from: "PROG2", to: "CPY", kind: "COPIES",
      confidence: "deterministic",
      evidence: { sourceFile: "PROG2.cbl", line: 5 },
    });
    // PROG3 calls PROG1
    b.addEdge({
      from: "PROG3", to: "PROG1", kind: "CALLS",
      confidence: "deterministic",
      evidence: { sourceFile: "PROG3.cbl", line: 10 },
    });

    const impact = b.impactOf("CPY");
    // Depth 1: PROG1, PROG2 (they COPY CPY)
    expect(impact.get(1)?.map((n) => n.id).sort()).toEqual(["PROG1", "PROG2"]);
    // Depth 2: PROG3 (calls PROG1)
    expect(impact.get(2)?.map((n) => n.id)).toEqual(["PROG3"]);
  });
});

// ---------------------------------------------------------------------------
// COBOL → Graph population
// ---------------------------------------------------------------------------

describe("populateGraphFromCobol", () => {
  it("creates Program node from PAYROLL.cbl", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [modelFor("PAYROLL.cbl")]);
    const graph = builder.build();

    expect(graph.nodes.get("PAYROLL")?.kind).toBe("Program");
  });

  it("creates CALLS edges from PAYROLL", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [modelFor("PAYROLL.cbl")]);
    const graph = builder.build();

    const calls = graph.edges.filter((e) => e.kind === "CALLS");
    expect(calls.length).toBe(2);
    expect(calls.every((e) => e.confidence === "deterministic")).toBe(true);
    expect(calls.every((e) => e.evidence.sourceFile === "PAYROLL.cbl")).toBe(true);
  });

  it("creates COPIES edges from INVOICE (which has COPY DATE-UTILS)", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [modelFor("INVOICE.cbl")]);
    const graph = builder.build();

    const copies = graph.edges.filter((e) => e.kind === "COPIES");
    expect(copies.length).toBeGreaterThanOrEqual(1);
    expect(copies[0].confidence).toBe("deterministic");
    expect(copies[0].kind).toBe("COPIES");
  });

  it("creates Dataset nodes from FD definitions", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [modelFor("PAYROLL.cbl")]);
    const graph = builder.build();

    const datasets = Array.from(graph.nodes.values()).filter((n) => n.kind === "Dataset");
    expect(datasets.length).toBeGreaterThanOrEqual(1);
    expect(datasets[0].id).toBe("EMPLOYEE-FILE");
  });

  it("creates Copybook node from DATE-UTILS.cpy", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [modelFor("DATE-UTILS.cpy")]);
    const graph = builder.build();

    const copybooks = Array.from(graph.nodes.values()).filter((n) => n.kind === "Copybook");
    expect(copybooks.length).toBeGreaterThanOrEqual(1);
  });

  it("populates multi-program graph with shared edges", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [
      modelFor("HELLO.cbl"),
      modelFor("PAYROLL.cbl"),
      modelFor("INVOICE.cbl"),
      modelFor("DATE-UTILS.cpy"),
    ]);
    const graph = builder.build();

    // Should have multiple programs + copybooks
    const programs = Array.from(graph.nodes.values()).filter((n) => n.kind === "Program");
    const copybooks = Array.from(graph.nodes.values()).filter((n) => n.kind === "Copybook");
    expect(programs.length).toBeGreaterThanOrEqual(3);
    expect(copybooks.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe("graph serialization", () => {
  it("round-trips through JSON", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [modelFor("PAYROLL.cbl")]);
    const graph = builder.build();

    const serialized = serializeGraph(graph);
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json);
    const restored = deserializeGraph(parsed);

    expect(restored.nodes.size).toBe(graph.nodes.size);
    expect(restored.edges.length).toBe(graph.edges.length);
    expect(restored.nodes.get("PAYROLL")?.kind).toBe("Program");
  });
});

// ---------------------------------------------------------------------------
// Export formats
// ---------------------------------------------------------------------------

describe("graph export", () => {
  it("generates valid Mermaid output", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [
      modelFor("PAYROLL.cbl"),
      modelFor("HELLO.cbl"),
    ]);
    const graph = builder.build();
    const mermaid = toMermaid(graph);

    expect(mermaid).toContain("graph LR");
    expect(mermaid).toContain("PAYROLL");
    expect(mermaid).toContain("-->");
  });

  it("generates valid DOT output", () => {
    const builder = new KnowledgeGraphBuilder();
    populateGraphFromCobol(builder, [modelFor("PAYROLL.cbl")]);
    const graph = builder.build();
    const dot = toDot(graph);

    expect(dot).toContain("digraph KnowledgeGraph");
    expect(dot).toContain("PAYROLL");
    expect(dot).toContain("->");
  });
});
