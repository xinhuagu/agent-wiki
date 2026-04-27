/**
 * Knowledge Graph — the stable intermediate model for cross-artifact analysis.
 *
 * Implements the 5-node + 4-edge schema defined in the PRD:
 *
 * Nodes: Program, Copybook, Job, Step, Dataset
 * Edges: CALLS, COPIES, EXECUTES, READS_WRITES
 *
 * Each edge carries a confidence tier and evidence provenance.
 * This module is language-agnostic — plugins populate it via the builder API.
 */

import { basename } from "node:path";

// ---------------------------------------------------------------------------
// Confidence model (3-tier)
// ---------------------------------------------------------------------------

/**
 * Three-tier confidence model for relationship edges.
 *
 * - deterministic: parsed directly from source — no inference
 * - inferred-high: dynamic but target is resolvable/unique
 * - inferred-low:  heuristic match, naming convention, or guess
 */
export type ConfidenceLevel = "deterministic" | "inferred-high" | "inferred-low";

export interface Evidence {
  /** Source file where this relationship was found */
  sourceFile: string;
  /** Line number in source (0 if not applicable) */
  line: number;
  /** Human-readable reason for the confidence level */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

export type NodeKind = "Program" | "Copybook" | "Job" | "Step" | "Dataset";

export interface GraphNode {
  /** Unique identifier (e.g. program-id, copybook name, job name) */
  id: string;
  /** Node type */
  kind: NodeKind;
  /**
   * Whether this node was backed by a parsed source artifact.
   *
   * - `true`  — created from a parsed source file (has sourceFile + metadata).
   * - `false` — placeholder created from a CALL/COPY/EXEC reference whose
   *             target was never parsed.  Downstream consumers MUST treat
   *             unresolved nodes as uncertain — they represent references,
   *             not verified artifacts.
   *
   * Defaults to `false` when omitted (placeholder semantics).
   * The builder promotes a placeholder to resolved when a source-backed
   * addNode() call supplies the same id with `resolved: true`.
   */
  resolved?: boolean;
  /** Source file this node was extracted from (undefined for placeholders) */
  sourceFile?: string;
  /** Additional metadata (language, division count, etc.) */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Edge types
// ---------------------------------------------------------------------------

export type EdgeKind = "CALLS" | "COPIES" | "EXECUTES" | "READS_WRITES";

export interface GraphEdge {
  /** Source node id */
  from: string;
  /** Target node id */
  to: string;
  /** Relationship type */
  kind: EdgeKind;
  /** Confidence level */
  confidence: ConfidenceLevel;
  /** Evidence chain */
  evidence: Evidence;
  /** Additional metadata (e.g. THRU target, REPLACING clauses, access mode) */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Knowledge Graph
// ---------------------------------------------------------------------------

export interface KnowledgeGraph {
  /** All nodes keyed by id */
  nodes: Map<string, GraphNode>;
  /** All edges */
  edges: GraphEdge[];
  /** Diagnostics: unresolved references, ambiguities */
  diagnostics: GraphDiagnostic[];
}

export interface GraphDiagnostic {
  severity: "warning" | "error" | "info";
  message: string;
  sourceFile?: string;
  line?: number;
}

/** Get all edges from a given node in a built graph. */
export function graphEdgesFrom(graph: KnowledgeGraph, nodeId: string): GraphEdge[] {
  return graph.edges.filter((e) => e.from === nodeId);
}

/** Get all edges to a given node in a built graph. */
export function graphEdgesTo(graph: KnowledgeGraph, nodeId: string): GraphEdge[] {
  return graph.edges.filter((e) => e.to === nodeId);
}

/** Get nodes that directly depend on the given node (reverse lookup). */
export function graphDependentsOf(graph: KnowledgeGraph, nodeId: string): GraphNode[] {
  const fromIds = graphEdgesTo(graph, nodeId).map((e) => e.from);
  return [...new Set(fromIds)].map((id) => graph.nodes.get(id)).filter(Boolean) as GraphNode[];
}

/**
 * Impact analysis over a built graph: given a changed node, find all transitively
 * affected nodes grouped by reverse-dependency depth.
 */
export function graphImpactOf(graph: KnowledgeGraph, nodeId: string, maxDepth = 10): Map<number, GraphNode[]> {
  const result = new Map<number, GraphNode[]>();
  const visited = new Set<string>([nodeId]);
  let frontier = [nodeId];
  let depth = 0;

  while (frontier.length > 0 && depth < maxDepth) {
    depth++;
    const nextFrontier: string[] = [];
    const levelNodes: GraphNode[] = [];

    for (const id of frontier) {
      for (const dep of graphDependentsOf(graph, id)) {
        if (!visited.has(dep.id)) {
          visited.add(dep.id);
          nextFrontier.push(dep.id);
          levelNodes.push(dep);
        }
      }
    }

    if (levelNodes.length > 0) {
      result.set(depth, levelNodes);
    }
    frontier = nextFrontier;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class KnowledgeGraphBuilder {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private diagnostics: GraphDiagnostic[] = [];

  // ---- nodes --------------------------------------------------------------

  addNode(node: GraphNode): this {
    // Default resolved to false (placeholder) when omitted
    const resolved = node.resolved ?? false;
    const existing = this.nodes.get(node.id);
    if (existing) {
      // Merge metadata — don't overwrite, extend
      existing.metadata = { ...existing.metadata, ...node.metadata };
      if (node.sourceFile && !existing.sourceFile) {
        existing.sourceFile = node.sourceFile;
      }
      // Promote: if the new node is resolved, upgrade the existing one.
      // A placeholder (resolved=false) that later gets parsed becomes resolved.
      if (resolved && !existing.resolved) {
        existing.resolved = true;
      }
    } else {
      this.nodes.set(node.id, { ...node, resolved });
    }
    return this;
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  // ---- edges --------------------------------------------------------------

  addEdge(edge: GraphEdge): this {
    this.edges.push({ ...edge });
    return this;
  }

  // ---- diagnostics --------------------------------------------------------

  addDiagnostic(diag: GraphDiagnostic): this {
    this.diagnostics.push(diag);
    return this;
  }

  // ---- queries ------------------------------------------------------------

  /** Get all edges from a given node */
  edgesFrom(nodeId: string): GraphEdge[] {
    return this.edges.filter((e) => e.from === nodeId);
  }

  /** Get all edges to a given node */
  edgesTo(nodeId: string): GraphEdge[] {
    return this.edges.filter((e) => e.to === nodeId);
  }

  /** Get all edges of a specific kind */
  edgesOfKind(kind: EdgeKind): GraphEdge[] {
    return this.edges.filter((e) => e.kind === kind);
  }

  /** Get nodes that directly depend on the given node (reverse lookup) */
  dependentsOf(nodeId: string): GraphNode[] {
    const fromIds = this.edgesTo(nodeId).map((e) => e.from);
    return [...new Set(fromIds)].map((id) => this.nodes.get(id)).filter(Boolean) as GraphNode[];
  }

  /** Get nodes that the given node depends on (forward lookup) */
  dependenciesOf(nodeId: string): GraphNode[] {
    const toIds = this.edgesFrom(nodeId).map((e) => e.to);
    return [...new Set(toIds)].map((id) => this.nodes.get(id)).filter(Boolean) as GraphNode[];
  }

  /**
   * Impact analysis: given a changed node, find all transitively affected nodes.
   * Uses BFS over reverse edges (dependentsOf).
   * Returns nodes grouped by distance from the changed node.
   */
  impactOf(nodeId: string, maxDepth = 10): Map<number, GraphNode[]> {
    const result = new Map<number, GraphNode[]>();
    const visited = new Set<string>([nodeId]);
    let frontier = [nodeId];
    let depth = 0;

    while (frontier.length > 0 && depth < maxDepth) {
      depth++;
      const nextFrontier: string[] = [];
      const levelNodes: GraphNode[] = [];

      for (const id of frontier) {
        for (const dep of this.dependentsOf(id)) {
          if (!visited.has(dep.id)) {
            visited.add(dep.id);
            nextFrontier.push(dep.id);
            levelNodes.push(dep);
          }
        }
      }

      if (levelNodes.length > 0) {
        result.set(depth, levelNodes);
      }
      frontier = nextFrontier;
    }

    return result;
  }

  // ---- build --------------------------------------------------------------

  build(): KnowledgeGraph {
    const validationDiagnostics: GraphDiagnostic[] = [];

    // Validate: warn about edges referencing non-existent nodes
    for (const edge of this.edges) {
      if (!this.nodes.has(edge.from)) {
        validationDiagnostics.push({
          severity: "warning",
          message: `Edge references unknown source node: ${edge.from}`,
          sourceFile: edge.evidence.sourceFile,
          line: edge.evidence.line,
        });
      }
      if (!this.nodes.has(edge.to)) {
        validationDiagnostics.push({
          severity: "warning",
          message: `Edge references unknown target node: ${edge.to} (unresolved ${edge.kind} from ${edge.from})`,
          sourceFile: edge.evidence.sourceFile,
          line: edge.evidence.line,
        });
      }
    }

    // Validate: surface unresolved nodes as diagnostics.
    // Nodes with resolved=false were created as placeholders from CALL/COPY
    // targets that were never backed by a parsed source file.  Collect the
    // referencing edges so the diagnostic carries provenance.
    for (const [id, node] of this.nodes) {
      if (!node.resolved) {
        const referencingEdges = this.edges.filter((e) => e.to === id);
        const referrers = referencingEdges.map((e) => e.from).join(", ");
        const firstRef = referencingEdges[0];
        validationDiagnostics.push({
          severity: "warning",
          message: `Unresolved ${node.kind} "${id}" — referenced by [${referrers}] but never parsed from source`,
          sourceFile: firstRef?.evidence.sourceFile,
          line: firstRef?.evidence.line,
        });
      }
    }

    return {
      nodes: new Map(this.nodes),
      edges: [...this.edges],
      diagnostics: [...this.diagnostics, ...validationDiagnostics],
    };
  }
}

// ---------------------------------------------------------------------------
// Canonical ID resolution
// ---------------------------------------------------------------------------

/**
 * Strip COBOL source file extensions to produce the logical name.
 *
 * Design decision: the canonical node id for any COBOL artifact is its
 * **logical name without file extension**.  This matches how COBOL itself
 * resolves references — `COPY DATE-UTILS` refers to the logical name, not
 * a filename.  By normalising here we guarantee that:
 *
 *   1. A parsed copybook (DATE-UTILS.cpy → "DATE-UTILS") and a COPY
 *      reference (COPY DATE-UTILS → "DATE-UTILS") resolve to the SAME node.
 *   2. Programs with a PROGRAM-ID always use that id (already extension-free).
 *   3. Programs whose PROGRAM-ID is missing fall back to the filename
 *      stripped of its extension, consistent with copybook handling.
 *
 * Supported extensions: .cbl, .cob, .cpy (case-insensitive).
 */
export function stripSourceExtension(filename: string): string {
  return basename(filename).replace(/\.(cpy|cbl|cob)$/i, "");
}

/**
 * Compute the canonical graph node id for a COBOL code model.
 *
 * - If programId is set (normal .cbl with PROGRAM-ID): use it as-is.
 * - Otherwise (standalone copybook, or .cbl missing PROGRAM-ID): strip
 *   the file extension from the basename of sourceFile to get the logical name.
 */
export function resolveCanonicalId(model: { programId: string; sourceFile: string }): string {
  return model.programId || stripSourceExtension(model.sourceFile);
}

/**
 * Build a namespaced canonical node ID.
 *
 * Format: `kind:LOGICAL-NAME` (lowercase kind prefix).
 * Examples: "program:PAYROLL", "copybook:DATE-UTILS", "dataset:EMP-FILE"
 *
 * Prevents identity collisions between node kinds that share a logical name
 * and makes the kind immediately visible in serialized/displayed graphs.
 */
export function canonicalNodeId(kind: NodeKind, logicalName: string): string {
  return `${kind.toLowerCase()}:${logicalName}`;
}

/**
 * Extract the display label (logical name without kind prefix) from a
 * canonical node ID.  Returns the input unchanged if no prefix is present.
 */
export function displayLabel(canonicalId: string): string {
  const i = canonicalId.indexOf(":");
  return i >= 0 ? canonicalId.substring(i + 1) : canonicalId;
}

// ---------------------------------------------------------------------------
// COBOL model → graph population
// ---------------------------------------------------------------------------

import type { CobolCodeModel } from "./extractors.js";

/**
 * Populate a KnowledgeGraphBuilder from one or more COBOL code models.
 * This is the bridge between the COBOL-specific model and the universal graph.
 */
export function populateGraphFromCobol(
  builder: KnowledgeGraphBuilder,
  models: CobolCodeModel[],
): void {
  for (const model of models) {
    const logicalName = resolveCanonicalId(model);
    const isCpy = model.sourceFile.toLowerCase().endsWith(".cpy");
    const nodeKind: NodeKind = isCpy ? "Copybook" : "Program";
    const nodeId = canonicalNodeId(nodeKind, logicalName);

    // Add program/copybook node — resolved: true because we parsed the source
    builder.addNode({
      id: nodeId,
      kind: nodeKind,
      resolved: true,
      sourceFile: model.sourceFile,
      metadata: {
        divisions: model.divisions.map((d) => d.name),
        sectionCount: model.sections.length,
        paragraphCount: model.paragraphs.length,
        dataItemCount: model.dataItems.length,
      },
    });

    // CALL edges → CALLS
    for (const call of model.calls) {
      const target = call.target;
      const isDynamic = !target.match(/^[A-Z0-9][-A-Z0-9]*$/i) || target.startsWith("WS-");
      const confidence: ConfidenceLevel = isDynamic ? "inferred-high" : "deterministic";
      const targetId = canonicalNodeId("Program", target);

      // Ensure target node exists — placeholder (resolved=false) until its source is parsed
      if (!builder.hasNode(targetId)) {
        builder.addNode({ id: targetId, kind: "Program", resolved: false });
      }

      builder.addEdge({
        from: nodeId,
        to: targetId,
        kind: "CALLS",
        confidence,
        evidence: {
          sourceFile: model.sourceFile,
          line: call.loc.line,
          reason: isDynamic
            ? `Dynamic CALL via variable (${call.fromParagraph})`
            : `Static CALL '${target}' in ${call.fromParagraph}`,
        },
        metadata: { fromParagraph: call.fromParagraph },
      });
    }

    // COPY edges → COPIES
    for (const copy of model.copies) {
      const copybookId = canonicalNodeId("Copybook", copy.copybook);

      // Ensure copybook node exists — placeholder (resolved=false) until its source is parsed
      if (!builder.hasNode(copybookId)) {
        builder.addNode({ id: copybookId, kind: "Copybook", resolved: false });
      }

      builder.addEdge({
        from: nodeId,
        to: copybookId,
        kind: "COPIES",
        confidence: "deterministic",
        evidence: {
          sourceFile: model.sourceFile,
          line: copy.loc.line,
          reason: `COPY ${copy.copybook}${copy.replacing ? " REPLACING ..." : ""}`,
        },
        metadata: copy.replacing ? { replacing: copy.replacing } : undefined,
      });
    }

    // File definitions → Dataset nodes + READS_WRITES edges
    for (const fd of model.fileDefinitions) {
      const datasetId = canonicalNodeId("Dataset", fd.fd);

      if (!builder.hasNode(datasetId)) {
        builder.addNode({
          id: datasetId,
          kind: "Dataset",
          resolved: true, // FD-backed: extracted from parsed source
          metadata: { recordName: fd.recordName },
        });
      } else {
        // Promote to resolved if previously created as placeholder
        const existing = builder.getNode(datasetId);
        if (existing && !existing.resolved) {
          existing.resolved = true;
        }
      }

      builder.addEdge({
        from: nodeId,
        to: datasetId,
        kind: "READS_WRITES",
        confidence: "deterministic",
        evidence: {
          sourceFile: model.sourceFile,
          line: fd.loc.line,
          reason: `FD ${fd.fd}${fd.recordName ? ` record ${fd.recordName}` : ""}`,
        },
        metadata: { recordName: fd.recordName },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export interface SerializedGraph {
  nodes: Array<GraphNode & { id: string }>;
  edges: GraphEdge[];
  diagnostics: GraphDiagnostic[];
}

export function serializeGraph(graph: KnowledgeGraph): SerializedGraph {
  return {
    nodes: Array.from(graph.nodes.values()),
    edges: graph.edges,
    diagnostics: graph.diagnostics,
  };
}

export function deserializeGraph(data: SerializedGraph): KnowledgeGraph {
  const nodes = new Map<string, GraphNode>();
  for (const node of data.nodes) {
    nodes.set(node.id, node);
  }
  return {
    nodes,
    edges: data.edges,
    diagnostics: data.diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Export formats
// ---------------------------------------------------------------------------

/** Export graph as Mermaid flowchart */
export function toMermaid(graph: KnowledgeGraph): string {
  const lines: string[] = ["graph LR"];
  const nodeStyles = new Map<NodeKind, string>([
    ["Program", ":::program"],
    ["Copybook", ":::copybook"],
    ["Job", ":::job"],
    ["Step", ":::step"],
    ["Dataset", ":::dataset"],
  ]);

  // Node declarations
  for (const [id, node] of graph.nodes) {
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const label = displayLabel(id);
    const shape = node.kind === "Program" ? `[${label}]`
      : node.kind === "Copybook" ? `([${label}])`
      : node.kind === "Dataset" ? `[(${label})]`
      : node.kind === "Job" ? `{{${label}}}`
      : `(${label})`;
    lines.push(`  ${safeId}${shape}`);
  }

  // Edge declarations
  for (const edge of graph.edges) {
    const from = edge.from.replace(/[^a-zA-Z0-9_-]/g, "_");
    const to = edge.to.replace(/[^a-zA-Z0-9_-]/g, "_");
    const label = edge.kind;
    const arrow = edge.confidence === "deterministic" ? "-->"
      : edge.confidence === "inferred-high" ? "-.->|?|"
      : "-..->|??|";
    lines.push(`  ${from} ${arrow} ${to}`);
  }

  // Style classes
  lines.push("");
  lines.push("  classDef program fill:#4A90D9,stroke:#2C5F8A,color:#fff");
  lines.push("  classDef copybook fill:#7B68EE,stroke:#5B48CE,color:#fff");
  lines.push("  classDef job fill:#F5A623,stroke:#D48B0F,color:#fff");
  lines.push("  classDef step fill:#F5D76E,stroke:#C9B458,color:#333");
  lines.push("  classDef dataset fill:#50C878,stroke:#3AA861,color:#fff");

  return lines.join("\n");
}

/** Export graph as DOT (Graphviz) */
export function toDot(graph: KnowledgeGraph): string {
  const lines: string[] = ["digraph KnowledgeGraph {"];
  lines.push("  rankdir=LR;");
  lines.push("  node [fontname=\"Helvetica\", fontsize=10];");
  lines.push("  edge [fontname=\"Helvetica\", fontsize=8];");

  const shapes: Record<NodeKind, string> = {
    Program: "box",
    Copybook: "ellipse",
    Job: "hexagon",
    Step: "parallelogram",
    Dataset: "cylinder",
  };

  const colors: Record<NodeKind, string> = {
    Program: "#4A90D9",
    Copybook: "#7B68EE",
    Job: "#F5A623",
    Step: "#F5D76E",
    Dataset: "#50C878",
  };

  // Nodes
  for (const [id, node] of graph.nodes) {
    const safeId = `"${id}"`;
    const label = displayLabel(id);
    const shape = shapes[node.kind] || "box";
    const color = colors[node.kind] || "#ccc";
    lines.push(`  ${safeId} [shape=${shape}, style=filled, fillcolor="${color}", label="${label}"];`);
  }

  // Edges
  for (const edge of graph.edges) {
    const from = `"${edge.from}"`;
    const to = `"${edge.to}"`;
    const style = edge.confidence === "deterministic" ? "solid"
      : edge.confidence === "inferred-high" ? "dashed"
      : "dotted";
    lines.push(`  ${from} -> ${to} [label="${edge.kind}", style=${style}];`);
  }

  lines.push("}");
  return lines.join("\n");
}
