export interface ParsedPage {
  /** Relative path from wiki root, e.g. "concept-gil.md" or "topic/foo.md" */
  path: string;
  /** Slug without .md, e.g. "concept-gil" or "topic/foo" */
  slug: string;
  /** Basename slug (for simple [[foo]] resolution), e.g. "foo" */
  basename: string;
  title: string;
  type?: string;
  tags: string[];
  sources: string[];
  /** First-level directory for coloring, e.g. "topic" from "topic/foo.md"; "" for root */
  topic: string;
  /** Raw link targets as written in the markdown (slug part only, before "|") */
  links: string[];
}

export interface GraphNode {
  id: string;
  path: string;
  title: string;
  type?: string;
  topic: string;
  primaryTag?: string;
  tags: string[];
  sources: string[];
  degree: number;
  inDegree: number;
  outDegree: number;
  /** True when no existing page links here and it links nowhere resolvable. */
  orphan: boolean;
  /** True when this node represents a link target that has no .md file. */
  broken: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** "wiki" = real [[link]]. Future: "tag", "similarity", etc. */
  type: "wiki";
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** ISO timestamp when this graph was built. */
  builtAt: string;
  /** Absolute wiki root directory the graph was built from. */
  wikiDir: string;
}
