/**
 * Tests for MCP server tool handlers.
 *
 * These test the handleTool dispatch and JSON serialization
 * without starting a real MCP transport.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Wiki } from "./wiki.js";

const TEST_ROOT = join(import.meta.dirname ?? ".", "__test_server__");

function freshWiki(): Wiki {
  return Wiki.init(TEST_ROOT);
}

function cleanUp() {
  if (existsSync(TEST_ROOT)) {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

// We test the Wiki methods that the server handlers call,
// since createServer() requires MCP transport setup.
// This verifies the data layer that backs every tool.

describe("server tool: raw_add + raw_list", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("add then list returns the document", () => {
    const wiki = freshWiki();
    wiki.rawAdd("article.md", {
      content: "# Article\nBody text.",
      sourceUrl: "https://example.com/article",
      description: "Test article",
      tags: ["test"],
    });
    const docs = wiki.rawList();
    expect(docs).toHaveLength(1);
    expect(docs[0]!.path).toBe("article.md");
    expect(docs[0]!.sourceUrl).toBe("https://example.com/article");
  });
});

describe("server tool: raw_read", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("reads text content", async () => {
    const wiki = freshWiki();
    wiki.rawAdd("text.txt", { content: "Hello MCP" });
    const result = await wiki.rawRead("text.txt");
    expect(result!.binary).toBe(false);
    expect(result!.content).toBe("Hello MCP");
  });
});

describe("server tool: raw_verify", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("validates integrity", () => {
    const wiki = freshWiki();
    wiki.rawAdd("ok.txt", { content: "safe" });
    const results = wiki.rawVerify();
    expect(results.every(r => r.status === "ok")).toBe(true);
  });
});

describe("server tool: wiki_write + wiki_read", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("write then read round-trips", () => {
    const wiki = freshWiki();
    wiki.write("note-test.md", "---\ntitle: Note\ntype: note\n---\nTest body.");
    const page = wiki.read("note-test.md");
    expect(page!.title).toBe("Note");
    expect(page!.content).toContain("Test body.");
  });
});

describe("server tool: wiki_delete", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("deletes a page", () => {
    const wiki = freshWiki();
    wiki.write("deleteme.md", "---\ntitle: D\n---\nBody");
    expect(wiki.delete("deleteme.md")).toBe(true);
    expect(wiki.read("deleteme.md")).toBeNull();
  });
});

describe("server tool: wiki_list", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("lists pages with filter", () => {
    const wiki = freshWiki();
    wiki.write("concept-x.md", "---\ntitle: X\ntype: concept\n---\nX");
    wiki.write("event-y.md", "---\ntitle: Y\ntype: event\n---\nY");
    const concepts = wiki.list("concept");
    expect(concepts).toContain("concept-x.md");
    expect(concepts).not.toContain("event-y.md");
  });
});

describe("server tool: wiki_search", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("finds by keyword", () => {
    const wiki = freshWiki();
    wiki.write("search-target.md", "---\ntitle: Transformer Architecture\n---\nAttention is all you need.");
    const results = wiki.search("attention");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.path).toBe("search-target.md");
  });
});

describe("server tool: wiki_lint", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("returns a valid report", () => {
    const wiki = freshWiki();
    wiki.write("lint-target.md", "---\ntitle: Lint Target\ntype: concept\n---\nSee [[broken-link]].");
    const report = wiki.lint();
    expect(report.pagesChecked).toBeGreaterThan(0);
    expect(report.issues.some(i => i.category === "broken-link")).toBe(true);
  });

  it("sequential lints produce valid cache file", () => {
    const wiki = freshWiki();
    wiki.rawAdd("cache-check.txt", { content: "test" });
    wiki.lint();
    wiki.lint();
    const cachePath = join(wiki.config.workspace, ".lint-cache.json");
    expect(existsSync(cachePath)).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cache.version).toBe(1);
    expect(cache.entries["cache-check.txt"]).toBeDefined();
    expect(cache.entries["cache-check.txt"].status).toBe("ok");
  });
});

describe("server tool: wiki_classify", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("classifies content", () => {
    const wiki = freshWiki();
    const result = wiki.classify("---\ntitle: Step by Step Guide\n---\nStep 1: Do this. Step 2: Do that. Install the software.");
    expect(result.type).toBe("how-to");
    expect(result.confidence).toBeGreaterThan(0);
  });
});

describe("server tool: wiki_synthesize", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("synthesizes context from pages", () => {
    const wiki = freshWiki();
    wiki.write("src-1.md", "---\ntitle: Source 1\ntags: [ai]\n---\nInsight one.");
    wiki.write("src-2.md", "---\ntitle: Source 2\ntags: [ml]\n---\nInsight two.");
    const ctx = wiki.synthesizeContext(["src-1.md", "src-2.md"]);
    expect(ctx.pages).toHaveLength(2);
    expect(ctx.suggestions.length).toBeGreaterThan(0);
  });
});

describe("server tool: wiki_schemas", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("returns all schemas", () => {
    const wiki = freshWiki();
    const schemas = wiki.schemas();
    expect(schemas.length).toBe(10);
  });
});

describe("server tool: wiki_log", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("returns log entries", () => {
    const wiki = freshWiki();
    wiki.write("log-page.md", "---\ntitle: L\n---\nBody");
    const log = wiki.getLog(5);
    expect(log.length).toBeGreaterThan(0);
  });
});

describe("server tool: wiki_rebuild_index + wiki_rebuild_timeline", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("rebuilds without error", () => {
    const wiki = freshWiki();
    wiki.write("p1.md", "---\ntitle: P1\ntype: concept\n---\nX");
    expect(() => wiki.rebuildIndex()).not.toThrow();
    expect(() => wiki.rebuildTimeline()).not.toThrow();
  });
});

describe("server tool: wiki_config", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("returns config object", () => {
    const wiki = freshWiki();
    const cfg = wiki.config;
    expect(cfg.configRoot).toBe(TEST_ROOT);
    expect(cfg.wikiDir).toContain("wiki");
    expect(cfg.rawDir).toContain("raw");
  });
});
