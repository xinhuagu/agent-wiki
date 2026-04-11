/**
 * Tests for MCP server tool handlers.
 *
 * These test the handleTool dispatch and JSON serialization
 * without starting a real MCP transport.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import { Wiki } from "./wiki.js";
import { handleTool, tryImageBlock, type ContentBlock } from "./server.js";
import { splitSections, buildToc } from "./wiki.js";

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

  it("returns plain text for small pages (< default limit)", async () => {
    const wiki = freshWiki();
    wiki.write("note-small.md", "---\ntitle: Small\ntype: note\n---\nJust a few lines.");
    const result = await handleTool(wiki, "wiki_read", { page: "note-small.md" });
    // Small page: backwards-compatible plain text, not JSON
    expect(typeof result).toBe("string");
    expect(result as string).toContain("Just a few lines.");
  });

  it("returns paginated JSON for large pages", async () => {
    const wiki = freshWiki();
    const body = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}`).join("\n");
    wiki.write("note-large.md", `---\ntitle: Large\ntype: note\n---\n${body}`);
    const result = await handleTool(wiki, "wiki_read", { page: "note-large.md" });
    const parsed = JSON.parse(result as string);
    expect(parsed.truncated).toBe(true);
    expect(parsed.total_lines).toBeGreaterThan(200);
    expect(parsed.lines_returned).toBe(200);
    expect(parsed.next_offset).toBe(200);
  });

  it("supports offset and limit for chunked reading", async () => {
    const wiki = freshWiki();
    const body = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}`).join("\n");
    wiki.write("note-large.md", `---\ntitle: Large\ntype: note\n---\n${body}`);
    const result = await handleTool(wiki, "wiki_read", { page: "note-large.md", offset: 100, limit: 50 });
    const parsed = JSON.parse(result as string);
    expect(parsed.offset).toBe(100);
    expect(parsed.lines_returned).toBe(50);
    expect(parsed.content).toContain("Line 98"); // offset=100 → 0-indexed line 100 = "Line 98" (after 4 frontmatter lines)
  });

  it("caps limit at 500", async () => {
    const wiki = freshWiki();
    const body = Array.from({ length: 600 }, (_, i) => `Line ${i + 1}`).join("\n");
    wiki.write("note-huge.md", `---\ntitle: Huge\ntype: note\n---\n${body}`);
    const result = await handleTool(wiki, "wiki_read", { page: "note-huge.md", limit: 9999 });
    const parsed = JSON.parse(result as string);
    expect(parsed.lines_returned).toBe(500);
  });

  it("includes TOC when page is truncated", async () => {
    const wiki = freshWiki();
    const body = [
      "## Overview", ...Array(50).fill("overview text"),
      "## Installation", ...Array(50).fill("install text"),
      "## Usage", ...Array(150).fill("usage text"),
    ].join("\n");
    wiki.write("note-toc.md", `---\ntitle: Guide\ntype: how-to\n---\n${body}`);
    const result = await handleTool(wiki, "wiki_read", { page: "note-toc.md" });
    const parsed = JSON.parse(result as string);
    expect(parsed.truncated).toBe(true);
    expect(parsed.toc).toContain("## Overview");
    expect(parsed.toc).toContain("## Installation");
    expect(parsed.toc).toContain("## Usage");
  });

  it("reads a specific section by heading", async () => {
    const wiki = freshWiki();
    const content = [
      "---", "title: Guide", "type: how-to", "---",
      "## Overview", "This is the overview.",
      "## Installation", "Run npm install here.",
      "## Usage", "Import the module.",
    ].join("\n");
    wiki.write("note-sections.md", content);
    const result = await handleTool(wiki, "wiki_read", { page: "note-sections.md", section: "Installation" });
    const parsed = JSON.parse(result as string);
    expect(parsed.section).toContain("Installation");
    expect(parsed.content).toContain("npm install");
    expect(parsed.content).not.toContain("Import the module");
  });

  it("throws with available sections when section not found", async () => {
    const wiki = freshWiki();
    wiki.write("note-secs.md", "---\ntitle: G\ntype: note\n---\n## Intro\nHello.\n## Details\nMore.");
    await expect(
      handleTool(wiki, "wiki_read", { page: "note-secs.md", section: "Nonexistent" })
    ).rejects.toThrow(/Intro|Details/);
  });
});

describe("splitSections", () => {
  it("splits by headings", () => {
    const md = "---\ntitle: X\n---\n## Intro\nHello.\n## Details\nMore info.";
    const sections = splitSections(md);
    expect(sections.some(s => s.heading === "## Intro")).toBe(true);
    expect(sections.some(s => s.heading === "## Details")).toBe(true);
  });

  it("does not treat # inside code fences as headings", () => {
    const md = "## Setup\n\n```bash\n# not a heading\nnpm install\n```\n\n## Usage\nDone.";
    const sections = splitSections(md);
    const headings = sections.map(s => s.heading).filter(Boolean);
    expect(headings).toEqual(["## Setup", "## Usage"]);
    expect(headings).not.toContain("# not a heading");
  });

  it("buildToc indentation is relative to shallowest heading (not absolute level)", () => {
    // All H2/H3 — H2 should show flush left, H3 indented once
    const md = "## Overview\n\nText.\n\n### Details\n\nMore.\n\n## Summary\n\nEnd.";
    const sections = splitSections(md);
    const toc = buildToc(sections);
    const lines = toc.split("\n");
    expect(lines[0]).toBe("## Overview");        // H2, minLevel=2 → 0 indent
    expect(lines[1]).toBe("  ### Details");      // H3 → 1 indent (2 spaces)
    expect(lines[2]).toBe("## Summary");
  });

  it("includes sub-sections under parent", async () => {
    const wiki = freshWiki();
    const content = [
      "---", "title: Doc", "type: note", "---",
      "## API", "Top-level API.",
      "### Method A", "Details of A.",
      "### Method B", "Details of B.",
      "## Examples", "Example content.",
    ].join("\n");
    wiki.write("note-sub.md", content);
    const result = await handleTool(wiki, "wiki_read", { page: "note-sub.md", section: "API" });
    const parsed = JSON.parse(result as string);
    expect(parsed.content).toContain("Method A");
    expect(parsed.content).toContain("Method B");
    expect(parsed.content).not.toContain("Example content");
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

  it("rejects deletion of nested index.md system pages", async () => {
    const wiki = freshWiki();
    wiki.write("lang/js/concept-js.md", "---\ntitle: JS\ntype: concept\n---\nJS.");
    wiki.rebuildIndex();

    expect(existsSync(join(wiki.config.wikiDir, "lang/js/index.md"))).toBe(true);

    // Nested index.md is a system page — deletion should be rejected
    await expect(
      handleTool(wiki, "wiki_delete", { page: "lang/js/index.md" })
    ).rejects.toThrow("Cannot delete system page");
  });

  it("rejects writing to nested index.md paths", () => {
    const wiki = freshWiki();
    expect(() =>
      wiki.write("lang/js/index.md", "---\ntitle: Custom\n---\nContent")
    ).toThrow("Cannot write to reserved path");
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

// ═══ Image ContentBlock tests (server layer) ═══════════════════

describe("tryImageBlock", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("returns image block for supported image file", () => {
    const wiki = freshWiki();
    const filePath = join(wiki.config.rawDir, "test.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(filePath, bytes);
    const block = tryImageBlock(filePath, "image/png");
    expect(block).not.toBeNull();
    expect(block!.type).toBe("image");
    expect((block as any).data).toBe(bytes.toString("base64"));
    expect((block as any).mimeType).toBe("image/png");
  });

  it("returns null for non-image mime types", () => {
    const wiki = freshWiki();
    const filePath = join(wiki.config.rawDir, "doc.pdf");
    writeFileSync(filePath, "fake pdf");
    expect(tryImageBlock(filePath, "application/pdf")).toBeNull();
  });

  it("returns null for non-existent file", () => {
    expect(tryImageBlock("/does/not/exist.png", "image/png")).toBeNull();
  });

  it("returns null for oversized image", () => {
    const wiki = freshWiki();
    const filePath = join(wiki.config.rawDir, "huge.png");
    writeFileSync(filePath, Buffer.alloc(11 * 1024 * 1024));
    expect(tryImageBlock(filePath, "image/png")).toBeNull();
  });
});

describe("handleTool: raw_add image ContentBlock[]", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("returns mixed [text, image] blocks for a single image file", async () => {
    const wiki = freshWiki();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const srcPath = join(TEST_ROOT, "input.png");
    writeFileSync(srcPath, pngBytes);

    const result = await handleTool(wiki, "raw_add", {
      filename: "diagram.png",
      source_path: srcPath,
    });

    expect(Array.isArray(result)).toBe(true);
    const blocks = result as ContentBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[1]!.type).toBe("image");
    const imgBlock = blocks[1] as { type: "image"; data: string; mimeType: string };
    expect(imgBlock.mimeType).toBe("image/png");
    expect(imgBlock.data).toBe(pngBytes.toString("base64"));
  });

  it("returns plain text string for non-image files", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "raw_add", {
      filename: "notes.md",
      content: "# Notes\nSome text.",
    });
    expect(typeof result).toBe("string");
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.document.path).toBe("notes.md");
  });
});

describe("handleTool: raw_read image ContentBlock[]", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("returns [text, image] blocks for displayable image", async () => {
    const wiki = freshWiki();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const rawPath = join(wiki.config.rawDir, "photo.png");
    writeFileSync(rawPath, pngBytes);
    writeFileSync(
      rawPath + ".meta.yaml",
      'path: photo.png\ndownloadedAt: "2024-01-01"\nsha256: abcd\nsize: 4\nmimeType: image/png\n'
    );

    const result = await handleTool(wiki, "raw_read", { filename: "photo.png" });

    expect(Array.isArray(result)).toBe(true);
    const blocks = result as ContentBlock[];
    expect(blocks).toHaveLength(2);
    // text first, image second — consistent with raw_add/raw_fetch
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[1]!.type).toBe("image");
    const textBlock = blocks[0] as { type: "text"; text: string };
    const parsed = JSON.parse(textBlock.text);
    expect(parsed.binary).toBe(true);
    expect(parsed.meta.mimeType).toBe("image/png");
    const imgBlock = blocks[1] as { type: "image"; data: string; mimeType: string };
    expect(imgBlock.mimeType).toBe("image/png");
    expect(imgBlock.data).toBe(pngBytes.toString("base64"));
  });

  it("returns text-only JSON for oversized image", async () => {
    const wiki = freshWiki();
    const bigSize = 11 * 1024 * 1024;
    const rawPath = join(wiki.config.rawDir, "big.jpg");
    writeFileSync(rawPath, Buffer.alloc(bigSize));
    writeFileSync(
      rawPath + ".meta.yaml",
      `path: big.jpg\ndownloadedAt: "2024-01-01"\nsha256: abcd\nsize: ${bigSize}\nmimeType: image/jpeg\n`
    );

    const result = await handleTool(wiki, "raw_read", { filename: "big.jpg" });

    expect(typeof result).toBe("string");
    const parsed = JSON.parse(result as string);
    expect(parsed.binary).toBe(true);
    expect(parsed.note).toMatch(/too large/i);
  });

  it("returns text content for non-image raw files", async () => {
    const wiki = freshWiki();
    wiki.rawAdd("readme.txt", { content: "Hello world" });

    const result = await handleTool(wiki, "raw_read", { filename: "readme.txt" });

    expect(typeof result).toBe("string");
    const parsed = JSON.parse(result as string);
    expect(parsed.binary).toBe(false);
    expect(parsed.content).toBe("Hello world");
  });

  it("throws for missing file", async () => {
    const wiki = freshWiki();
    await expect(handleTool(wiki, "raw_read", { filename: "nope.txt" }))
      .rejects.toThrow(/not found/i);
  });
});

describe("handleTool: raw_fetch image ContentBlock[] (mocked network)", () => {
  beforeEach(cleanUp);
  afterEach(() => {
    cleanUp();
    vi.restoreAllMocks();
  });

  function mockFetch(body: Buffer, contentType: string, status = 200) {
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(body));
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(readable, {
        status,
        headers: { "content-type": contentType },
      })
    );
  }

  it("returns [text, image] blocks when fetching an image", async () => {
    const wiki = freshWiki();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockFetch(pngBytes, "image/png");

    const result = await handleTool(wiki, "raw_fetch", {
      url: "https://example.com/photo.png",
      filename: "fetched.png",
    });

    expect(Array.isArray(result)).toBe(true);
    const blocks = result as ContentBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[1]!.type).toBe("image");
    // text block has document metadata
    const textBlock = blocks[0] as { type: "text"; text: string };
    const parsed = JSON.parse(textBlock.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.document.path).toBe("fetched.png");
    expect(parsed.document.mimeType).toBe("image/png");
    // image block has correct base64 data
    const imgBlock = blocks[1] as { type: "image"; data: string; mimeType: string };
    expect(imgBlock.mimeType).toBe("image/png");
    expect(imgBlock.data).toBe(pngBytes.toString("base64"));
  });

  it("returns plain text string when fetching a non-image file", async () => {
    const wiki = freshWiki();
    const htmlBytes = Buffer.from("<html><body>Hello</body></html>");
    mockFetch(htmlBytes, "text/html");

    const result = await handleTool(wiki, "raw_fetch", {
      url: "https://example.com/page.html",
      filename: "page.html",
    });

    expect(typeof result).toBe("string");
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.document.mimeType).toBe("text/html");
  });

  it("returns plain text string when fetched image exceeds 10 MB", async () => {
    const wiki = freshWiki();
    const bigImage = Buffer.alloc(11 * 1024 * 1024);
    mockFetch(bigImage, "image/jpeg");

    const result = await handleTool(wiki, "raw_fetch", {
      url: "https://example.com/huge.jpg",
      filename: "huge.jpg",
    });

    // tryImageBlock returns null for oversized → plain string, no image block
    expect(typeof result).toBe("string");
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.document.mimeType).toBe("image/jpeg");
  });
});
