import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractLinks, listMarkdownFiles, parsePage, readWikiPages } from "../src/parse.js";

describe("extractLinks", () => {
  it("extracts plain wikilinks", () => {
    expect(extractLinks("see [[foo]] and [[bar]]")).toEqual(["foo", "bar"]);
  });

  it("strips alias text after |", () => {
    expect(extractLinks("use [[foo|Fancy Foo]] here")).toEqual(["foo"]);
  });

  it("ignores single brackets", () => {
    expect(extractLinks("a [not-a-wikilink](x.md)")).toEqual([]);
  });

  it("trims whitespace inside brackets", () => {
    expect(extractLinks("[[  spaced  |label]]")).toEqual(["spaced"]);
  });
});

describe("parsePage", () => {
  it("extracts frontmatter and slug parts", () => {
    const raw = [
      "---",
      "title: Hello",
      "type: concept",
      "tags: [a, b]",
      "sources:",
      "  - https://example.com",
      "---",
      "",
      "Body with [[foo]] and [[bar/baz|BAZ]].",
    ].join("\n");
    const p = parsePage("topic/hello.md", raw);
    expect(p.title).toBe("Hello");
    expect(p.type).toBe("concept");
    expect(p.tags).toEqual(["a", "b"]);
    expect(p.sources).toEqual(["https://example.com"]);
    expect(p.slug).toBe("topic/hello");
    expect(p.basename).toBe("hello");
    expect(p.topic).toBe("topic");
    expect(p.links).toEqual(["foo", "bar/baz"]);
  });

  it("falls back to basename for missing title", () => {
    expect(parsePage("no-fm.md", "just body").title).toBe("no-fm");
  });
});

describe("readWikiPages", () => {
  it("walks nested directories and reads every .md file", () => {
    const root = mkdtempSync(join(tmpdir(), "aw-graph-"));
    try {
      writeFileSync(join(root, "top.md"), "top body [[sub/inner]]");
      mkdirSync(join(root, "sub"));
      writeFileSync(join(root, "sub", "inner.md"), "inner body");
      writeFileSync(join(root, "not-md.txt"), "ignored");

      const pages = readWikiPages(root);
      const slugs = pages.map((p) => p.slug).sort();
      expect(slugs).toEqual(["sub/inner", "top"]);

      const paths = listMarkdownFiles(root).sort();
      expect(paths).toEqual(["sub/inner.md", "top.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
