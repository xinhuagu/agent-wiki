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

  it("does not resurrect user-authored nested index after delete via wiki_delete", async () => {
    const wiki = freshWiki();
    // Create user-authored index + sibling page under lang/js/
    // Also add a sibling topic so lang/index.md has multiple sub-topics
    wiki.write("lang/js/index.md", "---\ntitle: My JS Guide\ntype: concept\n---\nCurated content.");
    wiki.write("lang/js/concept-closures.md", "---\ntitle: Closures\ntype: concept\n---\nClosures.");
    wiki.write("lang/python/concept-py.md", "---\ntitle: Python\ntype: concept\n---\nPython.");
    wiki.rebuildIndex();

    // User-authored index should be preserved by rebuild
    expect(readFileSync(join(wiki.config.wikiDir, "lang/js/index.md"), "utf-8")).toContain("Curated content");

    // Delete via handleTool (the wiki_delete server path)
    const result = await handleTool(wiki, "wiki_delete", { page: "lang/js/index.md" });
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);

    // The file must stay deleted — not resurrected as a generated index
    expect(existsSync(join(wiki.config.wikiDir, "lang/js/index.md"))).toBe(false);

    // Parent generated index should be refreshed and no longer link to deleted index
    const langIndex = readFileSync(join(wiki.config.wikiDir, "lang/index.md"), "utf-8");
    expect(langIndex).not.toContain("[[lang/js/index]]");
    // But the python sub-topic should still be there
    expect(langIndex).toContain("[[lang/python/index]]");
  });

  it("rejects deletion of generated index pages", async () => {
    const wiki = freshWiki();
    wiki.write("lang/js/concept-js.md", "---\ntitle: JS\ntype: concept\n---\nJS.");
    wiki.rebuildIndex();

    // Generated index should exist
    expect(existsSync(join(wiki.config.wikiDir, "lang/js/index.md"))).toBe(true);

    // Deletion should be rejected
    await expect(
      handleTool(wiki, "wiki_delete", { page: "lang/js/index.md" })
    ).rejects.toThrow("Cannot delete generated page");
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

  it("returns error string for missing file", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "raw_read", { filename: "nope.txt" });
    expect(typeof result).toBe("string");
    expect(result).toMatch(/not found/i);
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
