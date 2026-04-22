import { describe, expect, it } from "vitest";
import { buildGraph, resolveLink } from "../src/graph.js";
import type { ParsedPage } from "../src/types.js";

function page(partial: Partial<ParsedPage> & { slug: string }): ParsedPage {
  const slug = partial.slug;
  const base = slug.includes("/") ? slug.slice(slug.lastIndexOf("/") + 1) : slug;
  const topic = slug.includes("/") ? slug.slice(0, slug.indexOf("/")) : "";
  return {
    path: `${slug}.md`,
    slug,
    basename: base,
    title: partial.title ?? base,
    type: partial.type,
    tags: partial.tags ?? [],
    sources: partial.sources ?? [],
    topic,
    links: partial.links ?? [],
    ...partial,
  };
}

describe("resolveLink", () => {
  const slugs = new Set(["foo", "bar", "topic/baz"]);
  const byBase = new Map<string, string[]>([
    ["foo", ["foo"]],
    ["bar", ["bar"]],
    ["baz", ["topic/baz"]],
  ]);

  it("resolves by exact slug", () => {
    expect(resolveLink("foo", slugs, byBase)).toBe("foo");
    expect(resolveLink("topic/baz", slugs, byBase)).toBe("topic/baz");
  });

  it("strips .md suffix", () => {
    expect(resolveLink("foo.md", slugs, byBase)).toBe("foo");
  });

  it("resolves by unique basename", () => {
    expect(resolveLink("baz", slugs, byBase)).toBe("topic/baz");
  });

  it("returns null for ambiguous basenames", () => {
    const amb = new Map<string, string[]>([["dup", ["a/dup", "b/dup"]]]);
    expect(resolveLink("dup", new Set(["a/dup", "b/dup"]), amb)).toBeNull();
  });

  it("returns null for unknown links", () => {
    expect(resolveLink("nope", slugs, byBase)).toBeNull();
  });
});

describe("buildGraph", () => {
  it("builds nodes and real edges", () => {
    const pages = [
      page({ slug: "foo", links: ["bar", "topic/baz"] }),
      page({ slug: "bar", links: ["foo"] }),
      page({ slug: "topic/baz", links: [] }),
    ];
    const g = buildGraph(pages, "/tmp/wiki");
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["bar", "foo", "topic/baz"]);
    expect(g.edges).toHaveLength(3);
    const foo = g.nodes.find((n) => n.id === "foo")!;
    expect(foo.outDegree).toBe(2);
    expect(foo.inDegree).toBe(1);
    expect(foo.orphan).toBe(false);
  });

  it("flags orphan pages (no incoming links)", () => {
    const pages = [
      page({ slug: "hub", links: ["leaf"] }),
      page({ slug: "leaf", links: [] }),
      page({ slug: "lonely", links: [] }),
    ];
    const g = buildGraph(pages, "/tmp/wiki");
    const idToNode = new Map(g.nodes.map((n) => [n.id, n]));
    expect(idToNode.get("hub")!.orphan).toBe(true);
    expect(idToNode.get("leaf")!.orphan).toBe(false);
    expect(idToNode.get("lonely")!.orphan).toBe(true);
  });

  it("creates ghost nodes for broken links", () => {
    const pages = [page({ slug: "foo", links: ["does-not-exist"] })];
    const g = buildGraph(pages, "/tmp/wiki");
    const broken = g.nodes.find((n) => n.broken);
    expect(broken).toBeDefined();
    expect(broken!.id).toBe("__broken__:does-not-exist");
    expect(broken!.title).toBe("does-not-exist");
    expect(g.edges).toEqual([
      { source: "foo", target: "__broken__:does-not-exist", type: "wiki" },
    ]);
  });

  it("drops self-loops", () => {
    const pages = [page({ slug: "foo", links: ["foo"] })];
    const g = buildGraph(pages, "/tmp/wiki");
    expect(g.edges).toHaveLength(0);
  });

  it("strips alias text from link targets (parsed upstream)", () => {
    // parsePage already strips "|alias"; the graph builder trusts that.
    const pages = [
      page({ slug: "a", links: ["b"] }),
      page({ slug: "b", links: [] }),
    ];
    const g = buildGraph(pages, "/tmp");
    expect(g.edges[0]).toEqual({ source: "a", target: "b", type: "wiki" });
  });

  it("uses topic as first-level directory", () => {
    const pages = [
      page({ slug: "topic/a", links: [] }),
      page({ slug: "rootpage", links: [] }),
    ];
    const g = buildGraph(pages, "/tmp");
    expect(g.nodes.find((n) => n.id === "topic/a")!.topic).toBe("topic");
    expect(g.nodes.find((n) => n.id === "rootpage")!.topic).toBe("");
  });
});
