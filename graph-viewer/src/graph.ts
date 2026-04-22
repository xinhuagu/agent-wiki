import type { Graph, GraphEdge, GraphNode, ParsedPage } from "./types.js";

/**
 * Resolve a `[[link]]` target against the set of known pages.
 *
 * Priority (mirrors core wiki lint):
 *  1. Exact slug match (with or without .md)
 *  2. Basename match, if unique
 *
 * Returns the resolved page slug, or `null` if the link is broken.
 */
export function resolveLink(
  target: string,
  slugSet: Set<string>,
  basenameIndex: Map<string, string[]>,
): string | null {
  const bare = target.endsWith(".md") ? target.slice(0, -3) : target;
  if (slugSet.has(bare)) return bare;
  const candidates = basenameIndex.get(bare);
  if (candidates && candidates.length === 1) return candidates[0]!;
  return null;
}

/** Build a graph from parsed wiki pages. Pure — no I/O. */
export function buildGraph(pages: ParsedPage[], wikiDir: string): Graph {
  const slugSet = new Set(pages.map((p) => p.slug));
  const basenameIndex = new Map<string, string[]>();
  for (const p of pages) {
    const list = basenameIndex.get(p.basename) ?? [];
    list.push(p.slug);
    basenameIndex.set(p.basename, list);
  }

  const edges: GraphEdge[] = [];
  const brokenTargets = new Set<string>();
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();

  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const page of pages) {
    for (const target of page.links) {
      const resolved = resolveLink(target, slugSet, basenameIndex);
      if (resolved) {
        if (resolved === page.slug) continue; // drop self-loops — they clutter the graph
        edges.push({ source: page.slug, target: resolved, type: "wiki" });
        bump(outDegree, page.slug);
        bump(inDegree, resolved);
      } else {
        const ghostId = `__broken__:${target}`;
        edges.push({ source: page.slug, target: ghostId, type: "wiki" });
        brokenTargets.add(target);
        bump(outDegree, page.slug);
        bump(inDegree, ghostId);
      }
    }
  }

  const nodes: GraphNode[] = pages.map((p) => {
    const inD = inDegree.get(p.slug) ?? 0;
    const outD = outDegree.get(p.slug) ?? 0;
    return {
      id: p.slug,
      path: p.path,
      title: p.title,
      type: p.type,
      topic: p.topic,
      primaryTag: p.tags[0],
      tags: p.tags,
      sources: p.sources,
      degree: inD + outD,
      inDegree: inD,
      outDegree: outD,
      orphan: inD === 0,
      broken: false,
    };
  });

  for (const target of brokenTargets) {
    const id = `__broken__:${target}`;
    const inD = inDegree.get(id) ?? 0;
    nodes.push({
      id,
      path: target,
      title: target,
      type: "broken",
      topic: "",
      tags: [],
      sources: [],
      degree: inD,
      inDegree: inD,
      outDegree: 0,
      orphan: false,
      broken: true,
    });
  }

  return {
    nodes,
    edges,
    builtAt: new Date().toISOString(),
    wikiDir,
  };
}
