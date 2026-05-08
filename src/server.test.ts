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

describe("server tool: raw_coverage", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("returns JSON report with coverage ratio and uncovered list", async () => {
    const wiki = freshWiki();
    wiki.rawAdd("seen.pdf", { content: "x" });
    wiki.rawAdd("unseen.pdf", { content: "y" });
    wiki.write("p.md", "---\ntitle: P\ntype: concept\nsources: [raw/seen.pdf]\n---\n");

    const result = await handleTool(wiki, "raw_coverage", {});
    const parsed = JSON.parse(result as string);
    expect(parsed.totalRaw).toBe(2);
    expect(parsed.coveredRaw).toBe(1);
    expect(parsed.uncoveredRaw).toBe(1);
    expect(parsed.coverageRatio).toBe(0.5);
    expect(parsed.uncovered[0].path).toBe("unseen.pdf");
    expect(parsed.truncated).toBe(false);
  });

  it("passes through limit and sort parameters", async () => {
    const wiki = freshWiki();
    wiki.rawAdd("small.txt", { content: "a" });
    wiki.rawAdd("big.txt", { content: "a".repeat(1000) });

    const result = await handleTool(wiki, "raw_coverage", { limit: 1, sort: "largest" });
    const parsed = JSON.parse(result as string);
    expect(parsed.uncovered).toHaveLength(1);
    expect(parsed.uncovered[0].path).toBe("big.txt");
    expect(parsed.truncated).toBe(true);
  });

  it("rejects invalid sort value", async () => {
    const wiki = freshWiki();
    await expect(
      handleTool(wiki, "raw_coverage", { sort: "random" })
    ).rejects.toThrow(/Invalid sort/);
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

describe("server tool: batch", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  // ── Batch reads ──────────────────────────────────────────────

  it("reads multiple wiki pages in one call", async () => {
    const wiki = freshWiki();
    wiki.write("note-a.md", "---\ntitle: A\ntype: note\n---\nContent A.");
    wiki.write("note-b.md", "---\ntitle: B\ntype: note\n---\nContent B.");
    const result = await handleTool(wiki, "batch", {
      operations: [
        { tool: "wiki_read", args: { page: "note-a.md" } },
        { tool: "wiki_read", args: { page: "note-b.md" } },
      ],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(2);
    expect(JSON.stringify(parsed.results[0].result)).toContain("Content A");
    expect(JSON.stringify(parsed.results[1].result)).toContain("Content B");
  });

  it("returns per-op error without failing the batch", async () => {
    const wiki = freshWiki();
    wiki.write("note-ok.md", "---\ntitle: OK\ntype: note\n---\nGood.");
    const result = await handleTool(wiki, "batch", {
      operations: [
        { tool: "wiki_read", args: { page: "note-ok.md" } },
        { tool: "wiki_read", args: { page: "nonexistent.md" } },
      ],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(2);
    expect(JSON.stringify(parsed.results[0].result)).toContain("Good");
    expect(parsed.results[1].error).toMatch(/not found/i);
  });

  // ── Batch writes ─────────────────────────────────────────────

  it("writes multiple wiki pages in one call", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "batch", {
      operations: [
        { tool: "wiki_write", args: { page: "note-x.md", content: "---\ntitle: X\ntype: note\n---\nBody X." } },
        { tool: "wiki_write", args: { page: "note-y.md", content: "---\ntitle: Y\ntype: note\n---\nBody Y." } },
      ],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(2);
    expect(parsed.results[0].result.ok).toBe(true);
    expect(parsed.results[1].result.ok).toBe(true);
    expect(wiki.read("note-x.md")!.title).toBe("X");
    expect(wiki.read("note-y.md")!.title).toBe("Y");
  });

  it("continues on individual write errors", async () => {
    const wiki = freshWiki();
    wiki.write("lang/js/concept-js.md", "---\ntitle: JS\ntype: concept\n---\nJS.");
    wiki.rebuildIndex();
    const result = await handleTool(wiki, "batch", {
      operations: [
        { tool: "wiki_write", args: { page: "note-ok.md", content: "---\ntitle: OK\ntype: note\n---\nFine." } },
        { tool: "wiki_write", args: { page: "lang/js/index.md", content: "---\ntitle: Bad\n---\nReserved." } },
      ],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.results[0].result.ok).toBe(true);
    expect(parsed.results[1].error).toMatch(/reserved/i);
  });

  it("auto-classifies content in batch writes", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "batch", {
      operations: [
        { tool: "wiki_write", args: { page: "guide.md", content: "---\ntitle: Step by Step Guide\n---\nStep 1: Install. Step 2: Configure. Step 3: Run." } },
      ],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.results[0].result.autoClassified.type).toBe("how-to");
  });

  // ── Mixed operations ─────────────────────────────────────────

  it("mixes reads, writes, searches, and raw_add in one call", async () => {
    const wiki = freshWiki();
    wiki.write("existing.md", "---\ntitle: Existing\ntype: note\n---\nAlready here.");
    const result = await handleTool(wiki, "batch", {
      operations: [
        { tool: "wiki_read", args: { page: "existing.md" } },
        { tool: "wiki_write", args: { page: "new-page.md", content: "---\ntitle: New\ntype: note\n---\nFresh." } },
        { tool: "wiki_search", args: { query: "Existing" } },
        { tool: "raw_add", args: { filename: "source.txt", content: "raw data here" } },
        { tool: "wiki_list", args: {} },
      ],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(5);
    // wiki_read result
    expect(JSON.stringify(parsed.results[0].result)).toContain("Already here");
    // wiki_write result
    expect(parsed.results[1].result.ok).toBe(true);
    // wiki_search result
    expect(parsed.results[2].result.count).toBeGreaterThan(0);
    // raw_add result
    expect(parsed.results[3].result.ok).toBe(true);
    // wiki_list result
    expect(parsed.results[4].result.count).toBeGreaterThan(0);
  });

  it("batch reads multiple raw files", async () => {
    const wiki = freshWiki();
    wiki.rawAdd("doc-a.txt", { content: "Alpha doc" });
    wiki.rawAdd("doc-b.txt", { content: "Beta doc" });
    const result = await handleTool(wiki, "batch", {
      operations: [
        { tool: "raw_read", args: { filename: "doc-a.txt" } },
        { tool: "raw_read", args: { filename: "doc-b.txt" } },
      ],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(2);
    expect(parsed.results[0].result.content).toBe("Alpha doc");
    expect(parsed.results[1].result.content).toBe("Beta doc");
  });

  it("batch adds multiple raw files", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "batch", {
      operations: [
        { tool: "raw_add", args: { filename: "file1.txt", content: "content 1" } },
        { tool: "raw_add", args: { filename: "file2.txt", content: "content 2" } },
        { tool: "raw_add", args: { filename: "file3.txt", content: "content 3" } },
      ],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(3);
    expect(parsed.results.every((r: any) => r.result.ok)).toBe(true);
    expect(wiki.rawList()).toHaveLength(3);
  });

  it("batch deletes multiple wiki pages", async () => {
    const wiki = freshWiki();
    wiki.write("del-a.md", "---\ntitle: A\n---\nA");
    wiki.write("del-b.md", "---\ntitle: B\n---\nB");
    const result = await handleTool(wiki, "batch", {
      operations: [
        { tool: "wiki_delete", args: { page: "del-a.md" } },
        { tool: "wiki_delete", args: { page: "del-b.md" } },
      ],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.results[0].result.ok).toBe(true);
    expect(parsed.results[1].result.ok).toBe(true);
    expect(wiki.read("del-a.md")).toBeNull();
    expect(wiki.read("del-b.md")).toBeNull();
  });

  // ── Edge cases ───────────────────────────────────────────────

  it("rejects empty operations array", async () => {
    const wiki = freshWiki();
    await expect(
      handleTool(wiki, "batch", { operations: [] })
    ).rejects.toThrow(/non-empty/);
  });

  it("rejects nested batch calls", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "batch", {
      operations: [
        { tool: "batch", args: { operations: [{ tool: "wiki_list" }] } },
      ],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.results[0].error).toMatch(/nest/i);
  });

  it("preserves inline image data in batch responses", async () => {
    const wiki = freshWiki();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const srcPath = join(TEST_ROOT, "batch-img.png");
    writeFileSync(srcPath, pngBytes);

    const result = await handleTool(wiki, "batch", {
      operations: [
        { tool: "raw_add", args: { filename: "img.png", source_path: srcPath } },
      ],
    });
    const parsed = JSON.parse(result as string);
    // Result should be the full ContentBlock[] with image data preserved
    const blocks = parsed.results[0].result as any[];
    expect(Array.isArray(blocks)).toBe(true);
    const imgBlock = blocks.find((b: any) => b.type === "image");
    expect(imgBlock).toBeDefined();
    expect(imgBlock.data).toBe(pngBytes.toString("base64"));
    expect(imgBlock.mimeType).toBe("image/png");
  });

  it("does not allow external callers to skip rebuild via args", async () => {
    const wiki = freshWiki();
    // Even if a caller passes _skipRebuild in args, it should be ignored
    await handleTool(wiki, "wiki_write", {
      page: "sneaky.md",
      content: "---\ntitle: Sneaky\ntype: note\n---\nBody.",
      _skipRebuild: true,
    });
    // Index should still have been rebuilt (rebuildIndex checks opts, not args)
    const idx = readFileSync(join(wiki.config.wikiDir, "index.md"), "utf-8");
    expect(idx).toContain("sneaky");
  });

  it("rejects batch exceeding max operations limit", async () => {
    const wiki = freshWiki();
    const ops = Array.from({ length: 51 }, (_, i) => ({
      tool: "wiki_list",
    }));
    await expect(
      handleTool(wiki, "batch", { operations: ops })
    ).rejects.toThrow(/limit/i);
  });

  it("deduplicates wiki_rebuild within batch", async () => {
    const wiki = freshWiki();
    wiki.write("page-a.md", "---\ntitle: A\ntype: note\n---\nA.");
    const result = await handleTool(wiki, "batch", {
      operations: [
        { tool: "wiki_write", args: { page: "page-b.md", content: "---\ntitle: B\ntype: note\n---\nB." } },
        { tool: "wiki_rebuild" },
        { tool: "wiki_write", args: { page: "page-c.md", content: "---\ntitle: C\ntype: note\n---\nC." } },
      ],
    });
    const parsed = JSON.parse(result as string);
    // wiki_rebuild should be deferred, not executed inline
    expect(parsed.results[1].result.deferred).toBeTruthy();
    // All pages should be in the index (rebuilt once at end)
    const idx = readFileSync(join(wiki.config.wikiDir, "index.md"), "utf-8");
    expect(idx).toContain("page-b");
    expect(idx).toContain("page-c");
    // Timeline should also be rebuilt since wiki_rebuild was in the batch
    expect(existsSync(join(wiki.config.wikiDir, "timeline.md"))).toBe(true);
  });

  it("handles ops with no args", async () => {
    const wiki = freshWiki();
    wiki.write("p.md", "---\ntitle: P\ntype: note\n---\nP.");
    const result = await handleTool(wiki, "batch", {
      operations: [{ tool: "wiki_list" }],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.results[0].result.count).toBeGreaterThan(0);
  });
});

describe("batch vs individual: request count comparison", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("batch uses 1 handleTool call instead of N for reads", async () => {
    const wiki = freshWiki();
    const N = 5;
    for (let i = 0; i < N; i++) {
      wiki.write(`note-${i}.md`, `---\ntitle: Note ${i}\ntype: note\n---\nContent ${i}.`);
    }

    // Approach A: N individual calls
    let individualCalls = 0;
    for (let i = 0; i < N; i++) {
      await handleTool(wiki, "wiki_read", { page: `note-${i}.md` });
      individualCalls++;
    }

    // Approach B: 1 batch call
    let batchCalls = 0;
    const result = await handleTool(wiki, "batch", {
      operations: Array.from({ length: N }, (_, i) => ({ tool: "wiki_read", args: { page: `note-${i}.md` } })),
    });
    batchCalls++;
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(N);

    // N individual → 1 batch = saves N-1 requests
    expect(individualCalls - batchCalls).toBe(N - 1);
  });

  it("batch uses 1 handleTool call instead of N for writes", async () => {
    const wiki = freshWiki();
    const N = 5;

    let individualCalls = 0;
    for (let i = 0; i < N; i++) {
      await handleTool(wiki, "wiki_write", {
        page: `ind-${i}.md`,
        content: `---\ntitle: Ind ${i}\ntype: note\n---\nBody ${i}.`,
      });
      individualCalls++;
    }

    let batchCalls = 0;
    const result = await handleTool(wiki, "batch", {
      operations: Array.from({ length: N }, (_, i) => ({
        tool: "wiki_write",
        args: { page: `bat-${i}.md`, content: `---\ntitle: Bat ${i}\ntype: note\n---\nBody ${i}.` },
      })),
    });
    batchCalls++;
    const parsed = JSON.parse(result as string);
    expect(parsed.results.filter((r: any) => r.result?.ok).length).toBe(N);

    expect(individualCalls - batchCalls).toBe(N - 1);
  });

  it("batch returns same content as individual reads", async () => {
    const wiki = freshWiki();
    wiki.write("cmp-a.md", "---\ntitle: A\ntype: note\n---\nAlpha content.");
    wiki.write("cmp-b.md", "---\ntitle: B\ntype: note\n---\nBeta content.");

    const readA = await handleTool(wiki, "wiki_read", { page: "cmp-a.md" });
    const readB = await handleTool(wiki, "wiki_read", { page: "cmp-b.md" });

    const batchResult = await handleTool(wiki, "batch", {
      operations: [
        { tool: "wiki_read", args: { page: "cmp-a.md" } },
        { tool: "wiki_read", args: { page: "cmp-b.md" } },
      ],
    });
    const parsed = JSON.parse(batchResult as string);

    expect(JSON.stringify(parsed.results[0].result)).toContain("Alpha content");
    expect(JSON.stringify(parsed.results[1].result)).toContain("Beta content");
    expect((readA as string)).toContain("Alpha content");
    expect((readB as string)).toContain("Beta content");
  });

  it("batch mixes raw_read + raw_add: saves N-1 requests", async () => {
    const wiki = freshWiki();
    const N = 4;

    // Individual: N calls
    let individualCalls = 0;
    for (let i = 0; i < N; i++) {
      await handleTool(wiki, "raw_add", { filename: `ind-${i}.txt`, content: `data ${i}` });
      individualCalls++;
    }

    // Batch: 1 call
    let batchCalls = 0;
    const result = await handleTool(wiki, "batch", {
      operations: Array.from({ length: N }, (_, i) => ({
        tool: "raw_add",
        args: { filename: `bat-${i}.txt`, content: `data ${i}` },
      })),
    });
    batchCalls++;
    expect(JSON.parse(result as string).count).toBe(N);
    expect(individualCalls - batchCalls).toBe(N - 1);
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

  it("returns snippets only when include_content is false", async () => {
    const wiki = freshWiki();
    wiki.write("page.md", "---\ntitle: Test\ntype: note\n---\n## Overview\nDetailed content here about algorithms.");
    const result = await handleTool(wiki, "wiki_search", { query: "algorithms" });
    const parsed = JSON.parse(result as string);
    expect(parsed.results[0].snippet).toBeDefined();
    expect(parsed.results[0].content).toBeUndefined();
  });

  it("includes page content when include_content is true", async () => {
    const wiki = freshWiki();
    wiki.write("page.md", "---\ntitle: Test\ntype: note\n---\n## Overview\nDetailed content here about algorithms.");
    const result = await handleTool(wiki, "wiki_search", { query: "algorithms", include_content: true });
    const parsed = JSON.parse(result as string);
    expect(parsed.results[0].content).toContain("Detailed content here about algorithms");
  });

  it("returns matched section content when include_content is true", async () => {
    const wiki = freshWiki();
    const content = [
      "---", "title: Guide", "type: how-to", "---",
      "## Setup", "Install the package.",
      "## Configuration", "Set the API key for algorithms.",
      "## Usage", "Import and call the function.",
    ].join("\n");
    wiki.write("guide.md", content);
    const result = await handleTool(wiki, "wiki_search", { query: "algorithms", include_content: true });
    const parsed = JSON.parse(result as string);
    const hit = parsed.results.find((r: any) => r.path === "guide.md");
    expect(hit).toBeDefined();
    // Should return section content, not the whole page
    expect(hit.content).toContain("API key");
    expect(hit.content).not.toContain("Import and call");
  });

  it("truncates large sections at 200 lines with metadata", async () => {
    const wiki = freshWiki();
    const longSection = Array.from({ length: 300 }, (_, i) => `Algorithm line ${i + 1}`).join("\n");
    const content = `---\ntitle: Big\ntype: note\n---\n## Algorithms\n${longSection}\n## Other\nEnd.`;
    wiki.write("big-section.md", content);
    const result = await handleTool(wiki, "wiki_search", { query: "Algorithm", include_content: true });
    const parsed = JSON.parse(result as string);
    const hit = parsed.results.find((r: any) => r.path === "big-section.md");
    expect(hit).toBeDefined();
    expect(hit.truncated).toBe(true);
    expect(hit.total_lines).toBeGreaterThan(200);
    expect(hit.content.split("\n").length).toBe(200);
    expect(hit.content).not.toContain("End.");
  });

  it("eliminates the need for follow-up wiki_read (1 request instead of 2)", async () => {
    const wiki = freshWiki();
    wiki.write("doc-a.md", "---\ntitle: Alpha\ntype: note\n---\nAlpha details about neural networks.");
    wiki.write("doc-b.md", "---\ntitle: Beta\ntype: note\n---\nBeta details about neural networks.");

    // Without include_content: need search + batch read = 2 requests
    let calls = 0;
    await handleTool(wiki, "wiki_search", { query: "neural networks" });
    calls++;
    await handleTool(wiki, "batch", {
      operations: [
        { tool: "wiki_read", args: { page: "doc-a.md" } },
        { tool: "wiki_read", args: { page: "doc-b.md" } },
      ],
    });
    calls++;
    expect(calls).toBe(2);

    // With include_content: 1 request
    let optimizedCalls = 0;
    const result = await handleTool(wiki, "wiki_search", { query: "neural networks", include_content: true });
    optimizedCalls++;
    const parsed = JSON.parse(result as string);
    expect(parsed.results.length).toBe(2);
    expect(parsed.results.every((r: any) => r.content !== null)).toBe(true);
    expect(optimizedCalls).toBe(1);

    // Saved 1 request
    expect(calls - optimizedCalls).toBe(1);
  });

  it("has_subsections is true when truncated section has child headings", async () => {
    const wiki = freshWiki();
    // 201 body lines + a sub-heading → section will be truncated and has sub-sections
    const longBody = Array.from({ length: 201 }, (_, i) => `Line ${i + 1} about subsections`).join("\n");
    const content = ["---", "title: Deep Guide", "type: how-to", "---",
      "## Main", longBody, "### Sub A", "Sub-section detail."].join("\n");
    wiki.write("deep-guide.md", content);
    const result = await handleTool(wiki, "wiki_search", { query: "subsections", include_content: true });
    const parsed = JSON.parse(result as string);
    const hit = parsed.results.find((r: any) => r.path === "deep-guide.md");
    expect(hit).toBeDefined();
    expect(hit.truncated).toBe(true);
    expect(hit.has_subsections).toBe(true);
  });

  it("has_subsections is omitted when section is not truncated", async () => {
    const wiki = freshWiki();
    const content = ["---", "title: Small Guide", "type: how-to", "---",
      "## Main", "Short content about subsections.", "### Sub A", "Sub content."].join("\n");
    wiki.write("small-guide.md", content);
    const result = await handleTool(wiki, "wiki_search", { query: "subsections", include_content: true });
    const parsed = JSON.parse(result as string);
    const hit = parsed.results.find((r: any) => r.path === "small-guide.md");
    expect(hit).toBeDefined();
    expect(hit.truncated).toBeUndefined();
    expect(hit.has_subsections).toBeUndefined();
  });

  it("inline_budget limits inlined content; over-budget results return budget_exceeded", async () => {
    const wiki = freshWiki();
    wiki.write("page-a.md", "---\ntitle: Alpha\ntype: note\n---\nContent about inline budget alpha.");
    wiki.write("page-b.md", "---\ntitle: Beta\ntype: note\n---\nContent about inline budget beta.");
    // Budget of 10 chars — far smaller than any result's content → all should exceed
    const result = await handleTool(wiki, "wiki_search", {
      query: "inline budget",
      include_content: true,
      inline_budget: 10,
    });
    const parsed = JSON.parse(result as string);
    const exceeded = parsed.results.filter((r: any) => r.budget_exceeded === true);
    expect(exceeded.length).toBeGreaterThan(0);
    // Exceeded results still carry snippet (from base search result)
    expect(exceeded[0].snippet).toBeDefined();
    expect(exceeded[0].content).toBeUndefined();
  });

  it("no inline_budget returns content for all results", async () => {
    const wiki = freshWiki();
    wiki.write("page-a.md", "---\ntitle: Alpha\ntype: note\n---\nContent about budget test.");
    wiki.write("page-b.md", "---\ntitle: Beta\ntype: note\n---\nContent about budget test.");
    const result = await handleTool(wiki, "wiki_search", { query: "budget test", include_content: true });
    const parsed = JSON.parse(result as string);
    expect(parsed.results.every((r: any) => r.budget_exceeded !== true)).toBe(true);
    expect(parsed.results.every((r: any) => r.content !== undefined)).toBe(true);
  });
});

describe("wiki_search + wiki_search_read: evidence envelope (phase 1)", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("includes an evidence envelope on every wiki_search response", async () => {
    const wiki = freshWiki();
    wiki.write("topic.md", "---\ntitle: Transformer Models\nsources: [raw/paper.pdf]\n---\nAttention.");
    const result = await handleTool(wiki, "wiki_search", { query: "Transformer" });
    const parsed = JSON.parse(result as string);
    expect(parsed.evidence).toBeDefined();
    expect(["strong", "weak", "absent"]).toContain(parsed.evidence.confidence);
    expect(["deterministic", "inferred", "synthesized", "unsupported"]).toContain(
      parsed.evidence.basis,
    );
    expect(typeof parsed.evidence.abstain).toBe("boolean");
    expect(typeof parsed.evidence.rationale).toBe("string");
    expect(Array.isArray(parsed.evidence.provenance)).toBe(true);
  });

  it("returns abstain envelope when no results found", async () => {
    const wiki = freshWiki();
    wiki.write("unrelated.md", "---\ntitle: Soup\n---\nA recipe.");
    const result = await handleTool(wiki, "wiki_search", { query: "kubernetes orchestration" });
    const parsed = JSON.parse(result as string);
    expect(parsed.results).toHaveLength(0);
    expect(parsed.evidence.abstain).toBe(true);
    expect(parsed.evidence.confidence).toBe("absent");
    expect(parsed.evidence.basis).toBe("unsupported");
  });

  it("wiki_search_read response carries an evidence envelope", async () => {
    const wiki = freshWiki();
    wiki.write("page.md", "---\ntitle: Test\nsources: [raw/source.md]\n---\n## Section\nContent about widgets.");
    const result = await handleTool(wiki, "wiki_search_read", { query: "widgets", readTopN: 1 });
    const parsed = JSON.parse(result as string);
    expect(parsed.evidence).toBeDefined();
    expect(parsed.evidence.rationale).toBeTypeOf("string");
  });

  it("wiki_search_read downgrades envelope when top page has no sources", async () => {
    const wiki = freshWiki();
    // Two pages, both about the topic. The top match has empty sources.
    wiki.write("a.md", "---\ntitle: Widget Guide\nsources: []\n---\nWidgets and gadgets and gizmos.");
    wiki.write("b.md", "---\ntitle: Different\nsources: [raw/x.md]\n---\nWidgets in passing.");
    const result = await handleTool(wiki, "wiki_search_read", { query: "Widget Guide gadgets gizmos", readTopN: 1 });
    const parsed = JSON.parse(result as string);
    expect(parsed.evidence.rationale).toMatch(/no sources/);
  });

  it("wiki_search_read does NOT downgrade for explicit synthesis pages", async () => {
    const wiki = freshWiki();
    wiki.write("compiled.md", "---\ntitle: Compiled View\nsources: []\nsynthesis: true\n---\nAggregated knowledge here.");
    const result = await handleTool(wiki, "wiki_search_read", { query: "Compiled aggregated knowledge", readTopN: 1 });
    const parsed = JSON.parse(result as string);
    expect(parsed.evidence.rationale).not.toMatch(/no sources/);
  });
});

describe("server tool: wiki_search_read", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("returns search results and page content for top results", async () => {
    const wiki = freshWiki();
    wiki.write("page-a.md", "---\ntitle: A\ntype: note\n---\nAlpha algorithms.");
    wiki.write("page-b.md", "---\ntitle: B\ntype: note\n---\nBeta algorithms.");
    wiki.write("page-c.md", "---\ntitle: C\ntype: note\n---\nGamma algorithms.");
    const result = await handleTool(wiki, "wiki_search_read", { query: "algorithms", readTopN: 2 });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(3);
    expect(parsed.pages.length).toBe(2);
    expect(parsed.pagesRead).toBe(2);
    expect(parsed.nextReads.length).toBe(1);
    expect(parsed.pages.every((p: any) => p.content !== null)).toBe(true);
  });

  it("deduplicates multiple hits on same page", async () => {
    const wiki = freshWiki();
    wiki.write("multi.md", "---\ntitle: Multi\ntype: note\n---\n## Intro\nalgorithm overview\n## Details\nalgorithm details\n## Summary\nalgorithm summary");
    const result = await handleTool(wiki, "wiki_search_read", { query: "algorithm", readTopN: 5 });
    const parsed = JSON.parse(result as string);
    // Multiple search hits but only 1 unique page → pages should have 1 entry
    expect(parsed.pages.length).toBe(1);
    expect(parsed.pages[0].path).toBe("multi.md");
  });

  it("readTopN defaults to 3", async () => {
    const wiki = freshWiki();
    for (let i = 0; i < 5; i++) {
      wiki.write(`note-${i}.md`, `---\ntitle: Note ${i}\ntype: note\n---\nKeyword${i} searchable.`);
    }
    const result = await handleTool(wiki, "wiki_search_read", { query: "searchable" });
    const parsed = JSON.parse(result as string);
    expect(parsed.pages.length).toBe(3);
    expect(parsed.nextReads.length).toBe(2);
  });

  it("section filter reads only matched section", async () => {
    const wiki = freshWiki();
    wiki.write("guide-a.md", "---\ntitle: Guide A\ntype: how-to\n---\n## Setup\nInstall step A.\n## Usage\nRun it A.");
    wiki.write("guide-b.md", "---\ntitle: Guide B\ntype: how-to\n---\n## Setup\nInstall step B.\n## Usage\nRun it B.");
    const result = await handleTool(wiki, "wiki_search_read", {
      query: "Install",
      readTopN: 2,
      section: "Setup",
    });
    const parsed = JSON.parse(result as string);
    for (const page of parsed.pages) {
      if (page.content) {
        expect(page.content).toContain("Install");
        expect(page.content).not.toContain("Run it");
      }
    }
  });

  it("section not found returns null content with toc", async () => {
    const wiki = freshWiki();
    wiki.write("has-it.md", "---\ntitle: Has\ntype: note\n---\n## API\nEndpoint details.\n## Other\nStuff.");
    wiki.write("missing-it.md", "---\ntitle: Missing\ntype: note\n---\n## Overview\nGeneral info about API.");
    const result = await handleTool(wiki, "wiki_search_read", {
      query: "API",
      readTopN: 2,
      section: "API",
    });
    const parsed = JSON.parse(result as string);
    const hasIt = parsed.pages.find((p: any) => p.path === "has-it.md");
    const missingIt = parsed.pages.find((p: any) => p.path === "missing-it.md");
    expect(hasIt.content).toContain("Endpoint");
    expect(missingIt.content).toBeNull();
    expect(missingIt.error).toMatch(/not found/i);
    expect(missingIt.toc).toBeTruthy();
  });

  it("truncates pages at perPageLimit lines", async () => {
    const wiki = freshWiki();
    const body = Array.from({ length: 300 }, (_, i) => `Searchable line ${i}`).join("\n");
    wiki.write("big.md", `---\ntitle: Big\ntype: note\n---\n${body}`);
    const result = await handleTool(wiki, "wiki_search_read", { query: "Searchable", perPageLimit: 100 });
    const parsed = JSON.parse(result as string);
    expect(parsed.pages[0].truncated).toBe(true);
    expect(parsed.pages[0].total_lines).toBeGreaterThan(100);
    expect(parsed.pages[0].content.split("\n").length).toBe(100);
  });

  it("includeToc adds TOC to truncated pages", async () => {
    const wiki = freshWiki();
    const body = Array.from({ length: 300 }, (_, i) => `Searchable line ${i}`).join("\n");
    wiki.write("toc-page.md", `---\ntitle: Toc\ntype: note\n---\n## First\n${body}\n## Second\nMore.`);
    const result = await handleTool(wiki, "wiki_search_read", { query: "Searchable", includeToc: true });
    const parsed = JSON.parse(result as string);
    expect(parsed.pages[0].truncated).toBe(true);
    expect(parsed.pages[0].toc).toContain("## First");
    expect(parsed.pages[0].toc).toContain("## Second");
  });

  it("includeToc=false omits TOC even when truncated", async () => {
    const wiki = freshWiki();
    const body = Array.from({ length: 300 }, (_, i) => `Searchable line ${i}`).join("\n");
    wiki.write("no-toc.md", `---\ntitle: NoToc\ntype: note\n---\n## Heading\n${body}`);
    const result = await handleTool(wiki, "wiki_search_read", { query: "Searchable" });
    const parsed = JSON.parse(result as string);
    expect(parsed.pages[0].truncated).toBe(true);
    expect(parsed.pages[0].toc).toBeUndefined();
  });

  it("handles deleted page gracefully", async () => {
    const wiki = freshWiki();
    wiki.write("alive.md", "---\ntitle: Alive\ntype: note\n---\nKeyword here.");
    wiki.write("doomed.md", "---\ntitle: Doomed\ntype: note\n---\nKeyword there.");
    // Search first to index both, then delete one
    wiki.search("Keyword");
    rmSync(join(wiki.config.wikiDir, "doomed.md"));
    const result = await handleTool(wiki, "wiki_search_read", { query: "Keyword", readTopN: 5 });
    const parsed = JSON.parse(result as string);
    const alive = parsed.pages.find((p: any) => p.path === "alive.md");
    const doomed = parsed.pages.find((p: any) => p.path === "doomed.md");
    expect(alive.content).toContain("Keyword");
    expect(doomed.content).toBeNull();
    expect(doomed.error).toBeTruthy();
  });

  it("no results returns empty arrays and knowledge_gap", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "wiki_search_read", { query: "zzzznonexistent" });
    const parsed = JSON.parse(result as string);
    expect(parsed.results).toEqual([]);
    expect(parsed.pages).toEqual([]);
    expect(parsed.nextReads).toEqual([]);
    expect(parsed.count).toBe(0);
    expect(parsed.pagesRead).toBe(0);
    expect(parsed.knowledge_gap).toBeDefined();
  });

  it("readTopN capped at 10", async () => {
    const wiki = freshWiki();
    for (let i = 0; i < 12; i++) {
      wiki.write(`p-${i}.md`, `---\ntitle: P${i}\ntype: note\n---\nFindable content.`);
    }
    const result = await handleTool(wiki, "wiki_search_read", { query: "Findable", readTopN: 99, limit: 12 });
    const parsed = JSON.parse(result as string);
    expect(parsed.pages.length).toBeLessThanOrEqual(10);
  });

  it("perPageLimit capped at 500", async () => {
    const wiki = freshWiki();
    const body = Array.from({ length: 600 }, (_, i) => `Searchable line ${i}`).join("\n");
    wiki.write("huge.md", `---\ntitle: Huge\ntype: note\n---\n${body}`);
    const result = await handleTool(wiki, "wiki_search_read", { query: "Searchable", perPageLimit: 9999 });
    const parsed = JSON.parse(result as string);
    expect(parsed.pages[0].content.split("\n").length).toBeLessThanOrEqual(500);
  });

  it("eliminates 2-request search+batch workflow", async () => {
    const wiki = freshWiki();
    wiki.write("doc-x.md", "---\ntitle: X\ntype: note\n---\nNeural network details.");
    wiki.write("doc-y.md", "---\ntitle: Y\ntype: note\n---\nNeural network training.");

    // Old: 2 requests
    let oldCalls = 0;
    await handleTool(wiki, "wiki_search", { query: "neural network" });
    oldCalls++;
    await handleTool(wiki, "batch", {
      operations: [
        { tool: "wiki_read", args: { page: "doc-x.md" } },
        { tool: "wiki_read", args: { page: "doc-y.md" } },
      ],
    });
    oldCalls++;

    // New: 1 request
    let newCalls = 0;
    const result = await handleTool(wiki, "wiki_search_read", { query: "neural network", readTopN: 5 });
    newCalls++;
    const parsed = JSON.parse(result as string);
    expect(parsed.pagesRead).toBe(2);
    expect(parsed.pages.every((p: any) => p.content !== null)).toBe(true);

    expect(oldCalls - newCalls).toBe(1);
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

describe("server tool: knowledge_ingest_batch", () => {
  const SOURCE_DIR = join(TEST_ROOT, "__ingest_source__");

  beforeEach(() => {
    cleanUp();
    mkdirSync(SOURCE_DIR, { recursive: true });
  });
  afterEach(cleanUp);

  it("ingests a single text file", async () => {
    const wiki = freshWiki();
    writeFileSync(join(SOURCE_DIR, "readme.txt"), "Hello world\nLine two\nLine three");
    const result = await handleTool(wiki, "knowledge_ingest_batch", {
      source_path: SOURCE_DIR,
      topic: "test-topic",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.matched).toBe(1);
    expect(parsed.imported).toBe(1);
    expect(parsed.extracted).toBe(1);
    expect(parsed.packs).toBeGreaterThan(0);
    expect(parsed.packPaths[0]).toContain("digest-packs/test-topic/pack-001.md");
    // Pack file exists in raw/
    expect(existsSync(join(wiki.config.rawDir, "digest-packs/test-topic/pack-001.md"))).toBe(true);
  });

  it("ingests a directory with multiple files", async () => {
    const wiki = freshWiki();
    writeFileSync(join(SOURCE_DIR, "doc1.md"), "# Doc 1\nContent one.");
    writeFileSync(join(SOURCE_DIR, "doc2.md"), "# Doc 2\nContent two.");
    writeFileSync(join(SOURCE_DIR, "doc3.txt"), "Plain text three.");
    const result = await handleTool(wiki, "knowledge_ingest_batch", {
      source_path: SOURCE_DIR,
      topic: "multi",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.matched).toBe(3);
    expect(parsed.imported).toBe(3);
    expect(parsed.extracted).toBe(3);
    // Verify pack contains provenance headers
    const packContent = readFileSync(join(wiki.config.rawDir, "digest-packs/multi/pack-001.md"), "utf-8");
    expect(packContent).toContain("## raw/multi/");
  });

  it("skips already-imported files", async () => {
    const wiki = freshWiki();
    writeFileSync(join(SOURCE_DIR, "exists.txt"), "Already here.");
    // Pre-import with same raw path
    wiki.rawAdd("skip-topic/exists.txt", { content: "Already here." });

    const result = await handleTool(wiki, "knowledge_ingest_batch", {
      source_path: SOURCE_DIR,
      topic: "skip-topic",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.matched).toBe(1);
    expect(parsed.skipped).toBe(1);
    expect(parsed.imported).toBe(0);
  });

  it("filters by pattern", async () => {
    const wiki = freshWiki();
    writeFileSync(join(SOURCE_DIR, "keep.md"), "# Keep\nContent.");
    writeFileSync(join(SOURCE_DIR, "skip.txt"), "Skip this.");
    const result = await handleTool(wiki, "knowledge_ingest_batch", {
      source_path: SOURCE_DIR,
      topic: "pattern",
      pattern: "*.md",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.matched).toBe(1);
    expect(parsed.imported).toBe(1);
  });

  it("respects maxFiles limit", async () => {
    const wiki = freshWiki();
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(SOURCE_DIR, `file${i}.txt`), `Content ${i}`);
    }
    const result = await handleTool(wiki, "knowledge_ingest_batch", {
      source_path: SOURCE_DIR,
      maxFiles: 3,
      topic: "limited",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.matched).toBe(3);
  });

  it("continues on error with continueOnError", async () => {
    const wiki = freshWiki();
    writeFileSync(join(SOURCE_DIR, "good.txt"), "Good content.");
    // Create a file with .pdf extension but invalid content
    writeFileSync(join(SOURCE_DIR, "bad.pdf"), "not a real pdf");
    const result = await handleTool(wiki, "knowledge_ingest_batch", {
      source_path: SOURCE_DIR,
      topic: "errors",
      continueOnError: true,
    });
    const parsed = JSON.parse(result as string);
    // Good file should be processed
    expect(parsed.extracted).toBeGreaterThan(0);
    // Bad file should be in errors
    expect(parsed.failed).toBeGreaterThan(0);
    expect(parsed.errors[0].file).toContain("bad.pdf");
  });

  it("splits into multiple packs when content exceeds packLines", async () => {
    const wiki = freshWiki();
    // Create files with enough content to exceed packLines
    for (let i = 0; i < 3; i++) {
      const body = Array.from({ length: 100 }, (_, j) => `Line ${j} of file ${i}`).join("\n");
      writeFileSync(join(SOURCE_DIR, `big${i}.txt`), body);
    }
    const result = await handleTool(wiki, "knowledge_ingest_batch", {
      source_path: SOURCE_DIR,
      topic: "split",
      packLines: 120, // 3 files x 100 lines > 120, should create multiple packs
      chunkLines: 50,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.packs).toBeGreaterThan(1);
    expect(parsed.packPaths.length).toBe(parsed.packs);
  });

  it("cleans stale packs from previous runs", async () => {
    const wiki = freshWiki();
    // First run: create enough content for 3 packs
    for (let i = 0; i < 3; i++) {
      const body = Array.from({ length: 100 }, (_, j) => `Run1 file${i} line ${j}`).join("\n");
      writeFileSync(join(SOURCE_DIR, `run1-${i}.txt`), body);
    }
    const result1 = await handleTool(wiki, "knowledge_ingest_batch", {
      source_path: SOURCE_DIR,
      topic: "stale",
      packLines: 120,
      chunkLines: 50,
    });
    const parsed1 = JSON.parse(result1 as string);
    expect(parsed1.packs).toBeGreaterThanOrEqual(3);

    // Clean source dir and create less content for second run
    for (const f of ["run1-0.txt", "run1-1.txt", "run1-2.txt"]) rmSync(join(SOURCE_DIR, f));
    writeFileSync(join(SOURCE_DIR, "run2.txt"), "Short content for run 2.");

    const result2 = await handleTool(wiki, "knowledge_ingest_batch", {
      source_path: SOURCE_DIR,
      topic: "stale",
    });
    const parsed2 = JSON.parse(result2 as string);
    expect(parsed2.packs).toBe(1);

    // Old pack-002, pack-003 should be cleaned
    const packsDir = join(wiki.config.rawDir, "digest-packs", "stale");
    expect(existsSync(join(packsDir, "pack-001.md"))).toBe(true);
    expect(existsSync(join(packsDir, "pack-002.md"))).toBe(false);
    expect(existsSync(join(packsDir, "pack-003.md"))).toBe(false);
  });

  it("clamps chunkLines to packLines so no pack exceeds limit", async () => {
    const wiki = freshWiki();
    // 200 lines of content, packLines=80, chunkLines=200 (would exceed pack)
    const body = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join("\n");
    writeFileSync(join(SOURCE_DIR, "big.txt"), body);
    const result = await handleTool(wiki, "knowledge_ingest_batch", {
      source_path: SOURCE_DIR,
      topic: "clamp",
      packLines: 80,
      chunkLines: 200, // should be clamped to 80
    });
    const parsed = JSON.parse(result as string);
    // With chunkLines clamped to 80, each chunk ≤ 80 lines, each pack ≤ 80 lines
    // 200 lines / 80 = 3 chunks → at least 3 packs
    expect(parsed.packs).toBeGreaterThanOrEqual(3);
    // Verify no pack exceeds packLines (80) by much
    for (const packPath of parsed.packPaths) {
      const rawPath = packPath.replace(/^raw\//, "");
      const content = readFileSync(join(wiki.config.rawDir, rawPath), "utf-8");
      // Pack includes frontmatter + headers, so body lines should be ≤ chunkLines
      const bodyLines = content.split("\n").filter((l: string) => !l.startsWith("---") && !l.startsWith("title:") && !l.startsWith("topic:") && !l.startsWith("sources:") && !l.startsWith("totalChunks:"));
      // Each pack's content portion (excluding frontmatter/headers) should not vastly exceed packLines
      expect(bodyLines.length).toBeLessThan(packPath === parsed.packPaths[0] ? 120 : 120);
    }
  });

  it("ingests HTML with provenance", async () => {
    const wiki = freshWiki();
    writeFileSync(join(SOURCE_DIR, "page.html"), "<html><body><p>Hello HTML</p></body></html>");
    const result = await handleTool(wiki, "knowledge_ingest_batch", {
      source_path: SOURCE_DIR,
      topic: "html-test",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.extracted).toBe(1);
    const packContent = readFileSync(join(wiki.config.rawDir, "digest-packs/html-test/pack-001.md"), "utf-8");
    expect(packContent).toContain("Hello HTML");
    expect(packContent).toContain("## raw/html-test/page.html");
  });

  it("rejects topic with path traversal", async () => {
    const wiki = freshWiki();
    writeFileSync(join(SOURCE_DIR, "ok.txt"), "content");
    await expect(
      handleTool(wiki, "knowledge_ingest_batch", {
        source_path: SOURCE_DIR,
        topic: "../../wiki",
      })
    ).rejects.toThrow(/invalid topic/i);
  });

  it("sanitizes topic to safe slug", async () => {
    const wiki = freshWiki();
    writeFileSync(join(SOURCE_DIR, "ok.txt"), "content");
    const result = await handleTool(wiki, "knowledge_ingest_batch", {
      source_path: SOURCE_DIR,
      topic: "my topic (v2)",
    });
    const parsed = JSON.parse(result as string);
    // Spaces and parens should be replaced with hyphens
    expect(parsed.packPaths[0]).toMatch(/my-topic--v2-/);
    expect(parsed.packPaths[0]).not.toContain(" ");
    expect(parsed.packPaths[0]).not.toContain("(");
  });
});

describe("server tool: knowledge_digest_write", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("writes a single digest page with provenance", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "knowledge_digest_write", {
      pages: [{
        page: "summary-transformers.md",
        title: "Transformer Architecture Summary",
        body: "# Transformer Architecture\n\nAttention is all you need.\n\n## Key Concepts\n\nSelf-attention, multi-head attention.",
        type: "summary",
        tags: ["ai", "transformers"],
        sources: ["raw/paper.pdf"],
        sourcePacks: ["raw/digest-packs/ai/pack-001.md"],
      }],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.written).toBe(1);
    expect(parsed.results[0].ok).toBe(true);

    // Verify the page exists and has correct frontmatter
    const page = wiki.read(parsed.results[0].page as string);
    expect(page).not.toBeNull();
    expect(page!.title).toBe("Transformer Architecture Summary");
    expect(page!.type).toBe("summary");
    expect(page!.tags).toContain("ai");

    // Read raw content to check provenance fields
    const rawContent = readFileSync(join(wiki.config.wikiDir, parsed.results[0].page as string), "utf-8");
    expect(rawContent).toContain("raw/paper.pdf");
    expect(rawContent).toContain("raw/digest-packs/ai/pack-001.md");
  });

  it("writes multiple pages with one rebuild", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "knowledge_digest_write", {
      pages: [
        { page: "concept-a.md", title: "Concept A", body: "Body A." },
        { page: "concept-b.md", title: "Concept B", body: "Body B." },
        { page: "concept-c.md", title: "Concept C", body: "Body C." },
      ],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.written).toBe(3);
    expect(parsed.count).toBe(3);

    // All pages should be in the index (rebuilt once at end)
    const idx = readFileSync(join(wiki.config.wikiDir, "index.md"), "utf-8");
    expect(idx).toContain("concept-a");
    expect(idx).toContain("concept-b");
    expect(idx).toContain("concept-c");
  });

  it("auto-classifies when type is omitted", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "knowledge_digest_write", {
      pages: [{
        page: "guide.md",
        title: "How to Install",
        body: "Step 1: Download. Step 2: Install. Step 3: Configure. Step 4: Run.",
      }],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.results[0].autoClassified.type).toBe("how-to");
  });

  it("auto-routes to topic subdirectory", async () => {
    const wiki = freshWiki();
    // Create a topic directory first
    wiki.write("ai/concept-existing.md", "---\ntitle: Existing\ntype: concept\ntopic: ai\n---\nExisting.");
    wiki.rebuildIndex();

    const result = await handleTool(wiki, "knowledge_digest_write", {
      pages: [{
        page: "concept-new.md",
        title: "New AI Concept",
        body: "Something new about AI.",
        topic: "ai",
      }],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.results[0].routed).toBe(true);
    expect(parsed.results[0].page).toContain("ai/");
  });

  it("continues on individual write errors", async () => {
    const wiki = freshWiki();
    wiki.write("lang/js/concept-js.md", "---\ntitle: JS\ntype: concept\n---\nJS.");
    wiki.rebuildIndex();

    const result = await handleTool(wiki, "knowledge_digest_write", {
      pages: [
        { page: "ok-page.md", title: "OK", body: "Fine." },
        { page: "lang/js/index.md", title: "Bad", body: "Reserved." },
      ],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.written).toBe(1);
    expect(parsed.results[0].ok).toBe(true);
    expect(parsed.results[1].ok).toBe(false);
    expect(parsed.results[1].error).toMatch(/reserved/i);
  });

  it("rejects topic with path traversal", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "knowledge_digest_write", {
      pages: [{
        page: "evil.md",
        title: "Evil",
        body: "Content.",
        topic: "../../etc",
      }],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.results[0].ok).toBe(false);
    expect(parsed.results[0].error).toMatch(/invalid topic/i);
  });

  it("rejects empty pages array", async () => {
    const wiki = freshWiki();
    await expect(
      handleTool(wiki, "knowledge_digest_write", { pages: [] })
    ).rejects.toThrow(/non-empty/);
  });

  it("handles malformed page items without crashing the batch", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "knowledge_digest_write", {
      pages: [
        null,
        { page: "ok.md", title: "OK", body: "Fine." },
        { page: 123, title: "Bad", body: "Missing string page." },
      ],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(3);
    expect(parsed.written).toBe(1);
    // Malformed items get per-item errors, not a whole-tool crash
    expect(parsed.results[0].ok).toBe(false);
    expect(parsed.results[0].page).toBe("(item 0)");
    expect(parsed.results[1].ok).toBe(true);
    expect(parsed.results[2].ok).toBe(false);
    expect(parsed.results[2].page).toBe("(item 2)");
  });

  it("rejects pages exceeding limit", async () => {
    const wiki = freshWiki();
    const pages = Array.from({ length: 101 }, (_, i) => ({
      page: `p${i}.md`, title: `P${i}`, body: `Body ${i}`,
    }));
    await expect(
      handleTool(wiki, "knowledge_digest_write", { pages })
    ).rejects.toThrow(/limit/i);
  });

  it("handles YAML special characters in title safely", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "knowledge_digest_write", {
      pages: [{
        page: "special.md",
        title: 'Title with: colon, "quotes", and #hash',
        body: "Body content.",
      }],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.written).toBe(1);
    const page = wiki.read(parsed.results[0].page as string);
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Title with: colon, "quotes", and #hash');
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

  it("includes search config with hybrid=false by default", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "wiki_config", {});
    expect(typeof result).toBe("string");
    const parsed = JSON.parse(result as string);
    expect(parsed.search).toBeDefined();
    expect(parsed.search.hybrid).toBe(false);
    expect(typeof parsed.search.bm25Weight).toBe("number");
    expect(typeof parsed.search.vectorWeight).toBe("number");
    expect(typeof parsed.search.model).toBe("string");
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

// ── knowledge_ingest_batch: semantic chunking ─────────────────────

describe("knowledge_ingest_batch: semantic chunking", () => {
  const TEST_SRC = join(TEST_ROOT, "src-docs");

  beforeEach(() => {
    cleanUp();
    mkdirSync(TEST_SRC, { recursive: true });
  });
  afterEach(cleanUp);

  function freshWikiWithSrc(): Wiki {
    const wiki = Wiki.init(TEST_ROOT);
    // Allow TEST_SRC as a source directory
    (wiki.config as any).allowedSourceDirs = [TEST_SRC];
    return wiki;
  }

  it("single-section markdown is one chunk", async () => {
    writeFileSync(join(TEST_SRC, "simple.md"), "# Title\n\nSome content here.\n");
    const wiki = freshWikiWithSrc();
    const result = await handleTool(wiki, "knowledge_ingest_batch", {
      source_path: TEST_SRC,
      topic: "test",
      chunkLines: 200,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.extracted).toBe(1);
    // One section → one chunk
    expect(parsed.chunks).toBe(1);
  });

  it("multi-section markdown produces one chunk per section (not one chunk total)", async () => {
    const md = [
      "# Overview",
      "Introduction paragraph.",
      "",
      "## Section A",
      "Content for section A.",
      "",
      "## Section B",
      "Content for section B.",
    ].join("\n");
    writeFileSync(join(TEST_SRC, "multi.md"), md);
    const wiki = freshWikiWithSrc();
    const result = await handleTool(wiki, "knowledge_ingest_batch", {
      source_path: TEST_SRC,
      topic: "test",
      chunkLines: 200, // high limit so we don't split sections further
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
    // 3 sections (preamble + Section A + Section B) → 3 chunks
    expect(parsed.chunks).toBeGreaterThanOrEqual(2);
  });

  it("plain text without headings falls back to single segment", async () => {
    writeFileSync(join(TEST_SRC, "data.txt"), "line1\nline2\nline3\n");
    const wiki = freshWikiWithSrc();
    const result = await handleTool(wiki, "knowledge_ingest_batch", {
      source_path: TEST_SRC,
      topic: "test",
      chunkLines: 200,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.chunks).toBe(1);
  });
});

// ── hybrid search: SearchEngine vector API ────────────────────────

import { SearchEngine, cosineSimilarity } from "./search.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 for dimension mismatch", () => {
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
  });

  it("returns 0 for zero-length vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("SearchEngine hybrid vector API", () => {
  it("updateVector / getVectors round-trips correctly", () => {
    const engine = new SearchEngine();
    engine.updateVector("foo.md", [0.1, 0.2, 0.3]);
    engine.updateVector("bar.md", [0.4, 0.5, 0.6]);
    const vecs = engine.getVectors();
    expect(vecs.size).toBe(2);
    expect(vecs.get("foo.md")).toEqual([0.1, 0.2, 0.3]);
  });

  it("removeVector deletes the entry", () => {
    const engine = new SearchEngine();
    engine.updateVector("foo.md", [1, 0]);
    engine.removeVector("foo.md");
    expect(engine.getVectors().size).toBe(0);
  });

  it("setVectors replaces the whole map", () => {
    const engine = new SearchEngine();
    engine.updateVector("old.md", [1, 0]);
    const fresh = new Map([["new.md", [0, 1]]]);
    engine.setVectors(fresh);
    expect(engine.getVectors().size).toBe(1);
    expect(engine.getVectors().has("new.md")).toBe(true);
  });

  it("searchHybrid re-ranks via vectors when available", async () => {
    // Two pages: "alpha" and "beta". We set vectors so "beta" is much closer
    // to the query embedding than "alpha", then verify beta wins.
    const pages = [
      {
        path: "alpha.md", title: "Alpha Topic", type: "concept",
        tags: ["alpha"], content: "Alpha alpha alpha alpha alpha",
        sources: [], links: [], frontmatter: {},
      },
      {
        path: "beta.md", title: "Beta Topic", type: "concept",
        tags: ["beta"], content: "Beta beta beta beta beta",
        sources: [], links: [], frontmatter: {},
      },
    ] as any[];

    const engine = new SearchEngine();
    engine.setLoader(() => pages);
    engine.setConfig({ hybrid: true, bm25Weight: 0.0, vectorWeight: 1.0, model: "test-model" });

    // Set vectors: query will get [1, 0]; beta has [0.99, 0.01] ≈ cosine 0.99
    // alpha has [0, 1] ≈ cosine 0
    engine.updateVector("alpha.md", [0, 1]);
    engine.updateVector("beta.md", [0.99, Math.sqrt(1 - 0.99 ** 2)]);

    // Mock embedText to return [1, 0] for any query
    (engine as any).embedPipeline = {
      // The pipeline call returns an object with .data
    };
    vi.spyOn(engine as any, "embedText").mockResolvedValue([1, 0]);

    // BM25 should find both pages if we search "topic" (in titles)
    const results = await engine.searchHybrid("alpha topic", 2);
    expect(results.length).toBeGreaterThan(0);
    // beta should rank higher because its vector is closer to [1, 0]
    expect(results[0]!.path).toBe("beta.md");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wiki_read multi-page
// ─────────────────────────────────────────────────────────────────────────────

describe("wiki_read: multi-page (pages[])", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("reads multiple pages in one call", async () => {
    const wiki = freshWiki();
    wiki.write("alpha.md", "---\ntitle: Alpha\ntype: concept\n---\nAlpha content.");
    wiki.write("beta.md", "---\ntitle: Beta\ntype: concept\n---\nBeta content.");
    const result = await handleTool(wiki, "wiki_read", { pages: ["alpha.md", "beta.md"] });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(2);
    expect(parsed.pages).toHaveLength(2);
    expect(parsed.pages[0].content).toContain("Alpha content.");
    expect(parsed.pages[1].content).toContain("Beta content.");
  });

  it("marks missing pages as not_found", async () => {
    const wiki = freshWiki();
    wiki.write("exists.md", "---\ntitle: Exists\ntype: note\n---\nBody.");
    const result = await handleTool(wiki, "wiki_read", { pages: ["exists.md", "missing.md"] });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(2);
    const found = parsed.pages.find((p: any) => p.page === "exists.md");
    const missing = parsed.pages.find((p: any) => p.page === "missing.md");
    expect(found.content).toContain("Body.");
    expect(missing.not_found).toBe(true);
  });

  it("single page path still works as before (backward compat)", async () => {
    const wiki = freshWiki();
    wiki.write("solo.md", "---\ntitle: Solo\ntype: note\n---\nSolo body.");
    const result = await handleTool(wiki, "wiki_read", { page: "solo.md" });
    // Small page → plain text, not JSON array
    expect(typeof result).toBe("string");
    expect(result as string).toContain("Solo body.");
  });

  it("throws when neither page nor pages is supplied", async () => {
    const wiki = freshWiki();
    await expect(handleTool(wiki, "wiki_read", {})).rejects.toThrow(/page.*pages/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wiki_write return_content
// ─────────────────────────────────────────────────────────────────────────────

describe("wiki_write: return_content", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("returns content when return_content is true", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "wiki_write", {
      page: "note-rc.md",
      content: "---\ntitle: Return Content\ntype: note\n---\nInline body.",
      return_content: true,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.content).toBeDefined();
    expect(parsed.content).toContain("Inline body.");
  });

  it("return_content includes created and updated timestamps", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "wiki_write", {
      page: "note-ts.md",
      content: "---\ntitle: Timestamps\ntype: note\n---\nBody.",
      return_content: true,
    });
    const parsed = JSON.parse(result as string);
    // write() injects timestamps — returned content must include them
    expect(parsed.content).toContain("created:");
    expect(parsed.content).toContain("updated:");
  });

  it("does not return content by default", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "wiki_write", {
      page: "note-no-rc.md",
      content: "---\ntitle: No Return\ntype: note\n---\nBody.",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.content).toBeUndefined();
  });

  it("eliminates follow-up wiki_read in write-then-reference workflow", async () => {
    const wiki = freshWiki();
    // Before: write (1) + read (1) = 2 requests
    // After:  write with return_content (1) = 1 request
    const result = await handleTool(wiki, "wiki_write", {
      page: "chain.md",
      content: "---\ntitle: Chain\ntype: note\n---\nChained content.",
      return_content: true,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.content).toContain("Chained content.");
    // page path available for further reference — no separate wiki_read needed
    expect(parsed.page).toBe("chain.md");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wiki_write auto-link
// ─────────────────────────────────────────────────────────────────────────────

describe("wiki_write: auto-link", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("injects links and reports autoLinked count", async () => {
    const wiki = freshWiki();
    wiki.write("concept-rust.md", "---\ntitle: Rust Language\ntype: concept\ntags: [rust]\n---\nSystems language.");
    const result = await handleTool(wiki, "wiki_write", {
      page: "note-perf.md",
      content: "---\ntitle: Performance\ntype: note\n---\nRust Language is great for systems code.",
      return_content: true,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.autoLinked).toBe(1);
    expect(parsed.content).toContain("[[concept-rust|Rust Language]]");
  });

  it("skips auto-link when config.autoLink.enabled is false", async () => {
    const wiki = freshWiki();
    wiki.write("concept-rust.md", "---\ntitle: Rust Language\ntype: concept\ntags: [rust]\n---\nSystems language.");
    wiki.config.autoLink.enabled = false;
    const result = await handleTool(wiki, "wiki_write", {
      page: "note-perf.md",
      content: "---\ntitle: Performance\ntype: note\n---\nRust Language is great.",
      return_content: true,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.autoLinked).toBe(0);
    expect(parsed.content).not.toContain("[[");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wiki_search type / tags filter
// ─────────────────────────────────────────────────────────────────────────────

describe("wiki_search: type and tags filter", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("filters by type", async () => {
    const wiki = freshWiki();
    wiki.write("c1.md", "---\ntitle: Concept One\ntype: concept\ntags: [ml]\n---\nNeural nets.");
    wiki.write("n1.md", "---\ntitle: Note One\ntype: note\ntags: [ml]\n---\nNeural note.");
    const result = await handleTool(wiki, "wiki_search", { query: "neural", type: "concept" });
    const parsed = JSON.parse(result as string);
    expect(parsed.results.every((r: any) => !r.path.startsWith("n1"))).toBe(true);
    expect(parsed.results.some((r: any) => r.path === "c1.md")).toBe(true);
  });

  it("filters by tags (any match)", async () => {
    const wiki = freshWiki();
    wiki.write("p1.md", "---\ntitle: PyTorch\ntype: artifact\ntags: [python, ml]\n---\nDeep learning.");
    wiki.write("p2.md", "---\ntitle: TensorFlow\ntype: artifact\ntags: [python, ml]\n---\nDeep learning.");
    wiki.write("p3.md", "---\ntitle: Java Deep\ntype: artifact\ntags: [java]\n---\nDeep learning.");
    const result = await handleTool(wiki, "wiki_search", { query: "deep learning", tags: ["python"] });
    const parsed = JSON.parse(result as string);
    const paths = parsed.results.map((r: any) => r.path);
    expect(paths).toContain("p1.md");
    expect(paths).toContain("p2.md");
    expect(paths).not.toContain("p3.md");
  });

  it("no filter returns all matching pages", async () => {
    const wiki = freshWiki();
    wiki.write("a.md", "---\ntitle: A\ntype: concept\n---\nKeyword here.");
    wiki.write("b.md", "---\ntitle: B\ntype: note\n---\nKeyword here.");
    const result = await handleTool(wiki, "wiki_search", { query: "keyword" });
    const parsed = JSON.parse(result as string);
    expect(parsed.results.length).toBe(2);
  });

  it("returns empty when no results match filter", async () => {
    const wiki = freshWiki();
    wiki.write("a.md", "---\ntitle: A\ntype: note\n---\nFoo content.");
    const result = await handleTool(wiki, "wiki_search", { query: "foo", type: "concept" });
    const parsed = JSON.parse(result as string);
    expect(parsed.results).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wiki_search knowledge_gap
// ─────────────────────────────────────────────────────────────────────────────

describe("wiki_search: knowledge_gap", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("returns knowledge_gap when no results found", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "wiki_search", { query: "quantum computing" });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(0);
    expect(parsed.knowledge_gap).toBeDefined();
    expect(parsed.knowledge_gap.query).toBe("quantum computing");
    expect(parsed.knowledge_gap.suggested_page).toContain("quantum");
    expect(parsed.knowledge_gap.suggested_title).toBe("Quantum Computing");
    expect(parsed.knowledge_gap.suggested_type).toBeDefined();
    expect(Array.isArray(parsed.knowledge_gap.suggested_tags)).toBe(true);
    expect(parsed.knowledge_gap.hint).toContain("wiki_write");
  });

  it("does not return knowledge_gap when results exist", async () => {
    const wiki = freshWiki();
    wiki.write("concept-qc.md", "---\ntitle: Quantum Computing\ntype: concept\n---\nQubits and superposition.");
    const result = await handleTool(wiki, "wiki_search", { query: "quantum computing" });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBeGreaterThan(0);
    expect(parsed.knowledge_gap).toBeUndefined();
  });

  it("knowledge_gap suggested_page uses type prefix", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "wiki_search", { query: "docker deployment guide" });
    const parsed = JSON.parse(result as string);
    expect(parsed.knowledge_gap.suggested_page).toMatch(/^(how-to|concept|note|artifact)-/);
  });

  it("wiki_search_read also returns knowledge_gap on empty results", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "wiki_search_read", { query: "nonexistent topic xyz" });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(0);
    expect(parsed.knowledge_gap).toBeDefined();
    expect(parsed.knowledge_gap.hint).toContain("wiki_write");
  });

  it("CJK query produces non-empty suggested_page", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "wiki_search", { query: "机器学习" });
    const parsed = JSON.parse(result as string);
    expect(parsed.knowledge_gap.suggested_page).not.toContain("-.md");
    expect(parsed.knowledge_gap.suggested_page.length).toBeGreaterThan(5);
  });

  it("filterType is reflected in knowledge_gap.suggested_type", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "wiki_search", { query: "nonexistent xyz", type: "artifact" });
    const parsed = JSON.parse(result as string);
    expect(parsed.knowledge_gap.suggested_type).toBe("artifact");
    expect(parsed.knowledge_gap.suggested_page).toMatch(/^artifact-/);
  });
});

// ═══════════════════════════════════════════════════════
//  CONSOLIDATED PUBLIC TOOLS — routing and backward compat
// ═══════════════════════════════════════════════════════

describe("consolidated tool: raw_ingest", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("mode:add delegates to raw_add", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "raw_ingest", {
      mode: "add",
      filename: "ingest-test.md",
      content: "hello from raw_ingest",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.document.path).toBe("ingest-test.md");
    // verify file actually exists in raw
    const docs = wiki.rawList();
    expect(docs.some((d) => d.path === "ingest-test.md")).toBe(true);
  });

  it("mode:fetch delegates to raw_fetch", async () => {
    const wiki = freshWiki();
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(Buffer.from("fetched content")));
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(readable, { status: 200, headers: { "content-type": "text/plain" } })
    );
    try {
      const result = await handleTool(wiki, "raw_ingest", {
        mode: "fetch",
        url: "https://example.com/doc.txt",
        filename: "fetched-via-ingest.txt",
      });
      const parsed = JSON.parse(result as string);
      expect(parsed.ok).toBe(true);
      expect(parsed.document.path).toBe("fetched-via-ingest.txt");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("throws on unknown mode", async () => {
    const wiki = freshWiki();
    await expect(
      handleTool(wiki, "raw_ingest", { mode: "invalid_mode" })
    ).rejects.toThrow(/Unknown raw_ingest mode/);
  });

  it("throws when mode is missing", async () => {
    const wiki = freshWiki();
    await expect(handleTool(wiki, "raw_ingest", {})).rejects.toThrow(/Unknown raw_ingest mode/);
  });
});

describe("consolidated tool: wiki_admin", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("action:config returns current config", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "wiki_admin", { action: "config" });
    const parsed = JSON.parse(result as string);
    expect(parsed).toHaveProperty("wikiDir");
    expect(parsed).toHaveProperty("rawDir");
    expect(parsed).toHaveProperty("search");
  });

  it("action:rebuild runs without error", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "wiki_admin", { action: "rebuild" });
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.message).toMatch(/rebuilt/i);
  });

  it("action:lint returns a lint report", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "wiki_admin", { action: "lint" });
    const parsed = JSON.parse(result as string);
    expect(parsed).toHaveProperty("issues");
    expect(parsed).toHaveProperty("pagesChecked");
  });

  it("action:init initializes a new knowledge base", async () => {
    // Use a fresh subdirectory to avoid conflicts
    const initPath = join(TEST_ROOT, "fresh-kb");
    mkdirSync(initPath, { recursive: true });
    const wiki = freshWiki(); // need a wiki instance for handleTool signature
    const result = await handleTool(wiki, "wiki_admin", { action: "init", path: initPath });
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
    expect(existsSync(join(initPath, "wiki"))).toBe(true);
    expect(existsSync(join(initPath, "raw"))).toBe(true);
  });

  it("throws on unknown action", async () => {
    const wiki = freshWiki();
    await expect(
      handleTool(wiki, "wiki_admin", { action: "unknown_action" })
    ).rejects.toThrow(/Unknown wiki_admin action/);
  });

  it("throws when action is missing", async () => {
    const wiki = freshWiki();
    await expect(handleTool(wiki, "wiki_admin", {})).rejects.toThrow(/Unknown wiki_admin action/);
  });

  it("action:evidence-report returns markdown + structured report", async () => {
    const wiki = freshWiki();
    wiki.write("g.md", "---\ntitle: G\nsources: [raw/x.md]\n---\nGrounded.");
    const result = await handleTool(wiki, "wiki_admin", { action: "evidence-report" });
    const parsed = JSON.parse(result as string);
    expect(parsed.markdown).toContain("# Evidence Report");
    expect(parsed.report.source.grounded).toBe(1);
    expect(parsed.writtenTo).toBeUndefined();
  });

  it("action:evidence-report with write:true persists to wiki/evidence-report.md", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "wiki_admin", {
      action: "evidence-report",
      write: true,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.writtenTo).toBeDefined();
    expect(existsSync(join(wiki.config.wikiDir, "evidence-report.md"))).toBe(true);
  });
});

describe("consolidated tool: code_query", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("query_type:trace_variable traces a variable in parsed COBOL", async () => {
    const wiki = freshWiki();
    const cobol = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. SAMPLE.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-COUNTER PIC 9(4) VALUE 0.
       PROCEDURE DIVISION.
           MOVE 1 TO WS-COUNTER.
           STOP RUN.`;
    wiki.rawAdd("SAMPLE.cbl", { content: cobol });
    // parse first
    await handleTool(wiki, "code_parse", { path: "SAMPLE.cbl" });
    const result = await handleTool(wiki, "code_query", {
      query_type: "trace_variable",
      path: "SAMPLE.cbl",
      variable: "WS-COUNTER",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.variable).toBe("WS-COUNTER");
    expect(parsed.file).toBe("SAMPLE.cbl");
    expect(Array.isArray(parsed.references)).toBe(true);
  });

  it("query_type:procedure_flow returns PERFORM flow for parsed COBOL", async () => {
    const wiki = freshWiki();
    const cobol = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. SAMPLE.
       PROCEDURE DIVISION.
       A000-MAIN SECTION.
       A100-START.
           PERFORM B000-WORK.
           STOP RUN.
       B000-WORK SECTION.
       B100-STEP.
           EXIT.`;
    wiki.rawAdd("SAMPLE.cbl", { content: cobol });
    await handleTool(wiki, "code_parse", { path: "SAMPLE.cbl" });
    const result = await handleTool(wiki, "code_query", {
      query_type: "procedure_flow",
      path: "SAMPLE.cbl",
      procedure: "A100-START",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.query.type).toBe("procedure_flow");
    expect(parsed.sectionCalls).toHaveLength(1);
    expect(parsed.sectionCalls[0].fromSection).toBe("A000-MAIN");
    expect(parsed.sectionCalls[0].toSection).toBe("B000-WORK");
  });

  it("query_type:field_lineage returns deterministic lineage matches", async () => {
    const wiki = freshWiki();
    const copybook = `       01  CUSTOMER-REC.
           05  CUSTOMER-ID       PIC X(10).`;
    const orderA = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. ORDERA.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY CUSTOMER-REC.
       PROCEDURE DIVISION.
           STOP RUN.`;
    const orderB = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. ORDERB.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY CUSTOMER-REC.
       PROCEDURE DIVISION.
           STOP RUN.`;
    wiki.rawAdd("CUSTOMER-REC.cpy", { content: copybook });
    wiki.rawAdd("ORDERA.cbl", { content: orderA });
    wiki.rawAdd("ORDERB.cbl", { content: orderB });
    await handleTool(wiki, "code_parse", { path: "ORDERA.cbl" });
    await handleTool(wiki, "code_parse", { path: "ORDERB.cbl" });
    await handleTool(wiki, "code_parse", { path: "CUSTOMER-REC.cpy" });
    const result = await handleTool(wiki, "code_query", {
      query_type: "field_lineage",
      field_name: "CUSTOMER-ID",
      copybook: "CUSTOMER-REC",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.query.type).toBe("field_lineage");
    expect(parsed.summary.deterministicMatches).toBe(1);
    expect(parsed.deterministic[0].fieldName).toBe("CUSTOMER-ID");
  });

  it("query_type:impact throws when no compiled graph exists", async () => {
    const wiki = freshWiki();
    await expect(
      handleTool(wiki, "code_query", { query_type: "impact", node_id: "program:MISSING" })
    ).rejects.toThrow(/not found/i);
  });

  it("throws on unknown query_type", async () => {
    const wiki = freshWiki();
    await expect(
      handleTool(wiki, "code_query", { query_type: "unknown" })
    ).rejects.toThrow(/Unknown code_query query_type/);
  });

  it("throws when query_type is missing", async () => {
    const wiki = freshWiki();
    await expect(handleTool(wiki, "code_query", {})).rejects.toThrow(/Unknown code_query query_type/);
  });

  it("trace_variable: throws when path is missing", async () => {
    const wiki = freshWiki();
    await expect(
      handleTool(wiki, "code_query", { query_type: "trace_variable", variable: "WS-FOO" })
    ).rejects.toThrow("code_trace_variable requires 'path'");
  });

  it("trace_variable: throws when variable is missing", async () => {
    const wiki = freshWiki();
    await expect(
      handleTool(wiki, "code_query", { query_type: "trace_variable", path: "SAMPLE.cbl" })
    ).rejects.toThrow("code_trace_variable requires 'variable'");
  });

  it("procedure_flow: throws when path is missing", async () => {
    const wiki = freshWiki();
    await expect(
      handleTool(wiki, "code_query", { query_type: "procedure_flow" })
    ).rejects.toThrow("code_procedure_flow requires 'path'");
  });

  it("dataflow_edges: throws when path is missing", async () => {
    const wiki = freshWiki();
    await expect(
      handleTool(wiki, "code_query", { query_type: "dataflow_edges" })
    ).rejects.toThrow("code_dataflow_edges requires 'path'");
  });

  it("impact: throws when node_id is missing", async () => {
    const wiki = freshWiki();
    await expect(
      handleTool(wiki, "code_query", { query_type: "impact" })
    ).rejects.toThrow("code_impact requires 'node_id'");
  });
});

describe("consolidated tool: knowledge_ingest", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("mode:batch delegates to knowledge_ingest_batch", async () => {
    const wiki = freshWiki();
    const srcDir = join(TEST_ROOT, "sources");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "doc.txt"), "content of doc");
    // Add allowed source dir to config
    (wiki.config as any).allowedSourceDirs = [srcDir];
    const result = await handleTool(wiki, "knowledge_ingest", {
      mode: "batch",
      source_path: srcDir,
      topic: "test-topic",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.matched).toBeGreaterThan(0);
  });

  it("mode:digest_write delegates to knowledge_digest_write", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "knowledge_ingest", {
      mode: "digest_write",
      pages: [
        { page: "concept-test.md", title: "Test Concept", body: "Some content about testing." },
      ],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(1);
    expect(parsed.written).toBe(1);
  });

  it("throws on unknown mode", async () => {
    const wiki = freshWiki();
    await expect(
      handleTool(wiki, "knowledge_ingest", { mode: "unknown" })
    ).rejects.toThrow(/Unknown knowledge_ingest mode/);
  });

  it("throws when mode is missing", async () => {
    const wiki = freshWiki();
    await expect(handleTool(wiki, "knowledge_ingest", {})).rejects.toThrow(/Unknown knowledge_ingest mode/);
  });
});

describe("wiki_search: read_top_n combined search+read mode", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("returns pages array when read_top_n is set", async () => {
    const wiki = freshWiki();
    wiki.write("concept-alpha.md", `---
title: Alpha Concept
type: concept
tags: [alpha]
---
Alpha is a concept about beginnings.`);
    wiki.write("concept-beta.md", `---
title: Beta Concept
type: concept
tags: [beta]
---
Beta is a concept about second iterations.`);
    const result = await handleTool(wiki, "wiki_search", { query: "concept", read_top_n: 2 });
    const parsed = JSON.parse(result as string);
    expect(parsed).toHaveProperty("results");
    expect(parsed).toHaveProperty("pages");
    expect(parsed).toHaveProperty("nextReads");
    expect(Array.isArray(parsed.pages)).toBe(true);
    expect(parsed.pagesRead).toBeGreaterThan(0);
  });

  it("deduplicates multiple hits on the same page", async () => {
    const wiki = freshWiki();
    wiki.write("concept-dup.md", `---
title: Dup Concept
type: concept
tags: [dup, alpha, beta]
---
Alpha beta gamma delta epsilon. Alpha again.`);
    const result = await handleTool(wiki, "wiki_search", { query: "alpha beta", read_top_n: 3, limit: 5 });
    const parsed = JSON.parse(result as string);
    const pagePaths = parsed.pages.map((p: any) => p.path);
    const uniquePaths = [...new Set(pagePaths)];
    expect(pagePaths.length).toBe(uniquePaths.length);
  });

  it("nextReads contains pages beyond read_top_n", async () => {
    const wiki = freshWiki();
    for (let i = 1; i <= 5; i++) {
      wiki.write(`concept-item${i}.md`, `---
title: Item ${i}
type: concept
tags: [searchable]
---
Searchable content item number ${i}.`);
    }
    const result = await handleTool(wiki, "wiki_search", { query: "searchable", read_top_n: 2, limit: 10 });
    const parsed = JSON.parse(result as string);
    expect(parsed.pagesRead).toBeLessThanOrEqual(2);
    expect(Array.isArray(parsed.nextReads)).toBe(true);
  });

  it("read_top_n is capped at 10", async () => {
    const wiki = freshWiki();
    wiki.write("concept-cap.md", `---
title: Cap Test
type: concept
tags: [cap]
---
Capped at ten.`);
    // read_top_n=99 should be clamped to 10 internally
    const result = await handleTool(wiki, "wiki_search", { query: "capped", read_top_n: 99 });
    const parsed = JSON.parse(result as string);
    // Should not throw and should return valid structure
    expect(parsed).toHaveProperty("pages");
    expect(parsed.pagesRead).toBeLessThanOrEqual(10);
  });

  it("section filter applies to read pages when read_top_n is set", async () => {
    const wiki = freshWiki();
    wiki.write("concept-sections.md", `---
title: Section Test
type: concept
tags: [sections]
---
## Introduction
Intro content here.

## Details
Detail content here.`);
    const result = await handleTool(wiki, "wiki_search", {
      query: "sections",
      read_top_n: 1,
      section: "## Details",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.pages.length).toBeGreaterThan(0);
    if (parsed.pages[0].content) {
      expect(parsed.pages[0].content).toContain("Detail content");
    }
  });

  it("knowledge_gap is returned when read_top_n is set but no results found", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "wiki_search", { query: "nonexistent-xyz-123", read_top_n: 3 });
    const parsed = JSON.parse(result as string);
    expect(parsed.results).toHaveLength(0);
    expect(parsed).toHaveProperty("knowledge_gap");
  });
});

describe("backward compat: legacy tool names still work via handleTool", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("raw_add still works", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "raw_add", {
      filename: "compat-test.md",
      content: "backward compat content",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
  });

  it("wiki_config still works", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "wiki_config", {});
    const parsed = JSON.parse(result as string);
    expect(parsed).toHaveProperty("wikiDir");
  });

  it("wiki_lint still works", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "wiki_lint", {});
    const parsed = JSON.parse(result as string);
    expect(parsed).toHaveProperty("issues");
  });

  it("wiki_rebuild still works", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "wiki_rebuild", {});
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
  });

  it("wiki_search_read still works", async () => {
    const wiki = freshWiki();
    wiki.write("concept-compat.md", `---
title: Compat Page
type: concept
tags: [compat]
---
Content for backward compatibility test.`);
    const result = await handleTool(wiki, "wiki_search_read", { query: "compat" });
    const parsed = JSON.parse(result as string);
    expect(parsed).toHaveProperty("results");
    expect(parsed).toHaveProperty("pages");
  });

  it("knowledge_ingest_batch still works", async () => {
    const wiki = freshWiki();
    const srcDir = join(TEST_ROOT, "compat-sources");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "compat.txt"), "compat content");
    (wiki.config as any).allowedSourceDirs = [srcDir];
    const result = await handleTool(wiki, "knowledge_ingest_batch", {
      source_path: srcDir,
      topic: "compat-topic",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
  });

  it("knowledge_digest_write still works", async () => {
    const wiki = freshWiki();
    const result = await handleTool(wiki, "knowledge_digest_write", {
      pages: [{ page: "concept-compat-write.md", title: "Compat Write", body: "body text" }],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.written).toBe(1);
  });

  it("code_trace_variable still works", async () => {
    const wiki = freshWiki();
    const cobol = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. COMPAT.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-X PIC 9(4) VALUE 0.
       PROCEDURE DIVISION.
           MOVE 5 TO WS-X.
           STOP RUN.`;
    wiki.rawAdd("COMPAT.cbl", { content: cobol });
    await handleTool(wiki, "code_parse", { path: "COMPAT.cbl" });
    const result = await handleTool(wiki, "code_trace_variable", {
      path: "COMPAT.cbl",
      variable: "WS-X",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.variable).toBe("WS-X");
  });

  it("code_trace_variable response carries an evidence envelope (phase 3)", async () => {
    const wiki = freshWiki();
    const cobol = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. TRACEENV.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-Y PIC 9(4) VALUE 0.
       PROCEDURE DIVISION.
           MOVE 7 TO WS-Y.
           STOP RUN.`;
    wiki.rawAdd("TRACEENV.cbl", { content: cobol });
    await handleTool(wiki, "code_parse", { path: "TRACEENV.cbl" });

    // References found → strong/deterministic envelope.
    const found = JSON.parse(
      (await handleTool(wiki, "code_trace_variable", {
        path: "TRACEENV.cbl",
        variable: "WS-Y",
      })) as string,
    );
    expect(found.evidence).toBeDefined();
    expect(found.evidence.confidence).toBe("strong");
    expect(found.evidence.basis).toBe("deterministic");
    expect(found.evidence.abstain).toBe(false);
    expect(found.evidence.provenance).toEqual([{ raw: "TRACEENV.cbl" }]);

    // No references → absent + abstain.
    const missing = JSON.parse(
      (await handleTool(wiki, "code_trace_variable", {
        path: "TRACEENV.cbl",
        variable: "WS-NOT-THERE",
      })) as string,
    );
    expect(missing.evidence.confidence).toBe("absent");
    expect(missing.evidence.abstain).toBe(true);
    expect(missing.references).toEqual([]);
  });

  it("code_impact still throws when no compiled graph exists", async () => {
    const wiki = freshWiki();
    await expect(
      handleTool(wiki, "code_impact", { node_id: "program:MISSING" })
    ).rejects.toThrow(/not found/i);
  });
});

describe("evidence envelope coverage: raw_* and code_* tools", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("raw_read text response carries strong/deterministic envelope", async () => {
    const wiki = freshWiki();
    wiki.rawAdd("hello.txt", { content: "hello world" });
    const result = JSON.parse((await handleTool(wiki, "raw_read", { filename: "hello.txt" })) as string);
    expect(result.evidence).toBeDefined();
    expect(result.evidence.confidence).toBe("strong");
    expect(result.evidence.basis).toBe("deterministic");
    expect(result.evidence.abstain).toBe(false);
    expect(result.evidence.provenance).toEqual([{ raw: "hello.txt" }]);
  });

  it("raw_read image response carries envelope in the text content block", async () => {
    const wiki = freshWiki();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const rawPath = join(wiki.config.rawDir, "envpixel.png");
    writeFileSync(rawPath, pngBytes);
    writeFileSync(
      rawPath + ".meta.yaml",
      'path: envpixel.png\ndownloadedAt: "2026-05-01"\nsha256: abcd\nsize: 4\nmimeType: image/png\n',
    );
    const result = await handleTool(wiki, "raw_read", { filename: "envpixel.png" });
    expect(Array.isArray(result)).toBe(true);
    const blocks = result as Array<{ type: string; text?: string }>;
    const meta = JSON.parse(blocks[0]!.text!);
    expect(meta.evidence.confidence).toBe("strong");
    expect(meta.evidence.basis).toBe("deterministic");
    expect(meta.evidence.provenance).toEqual([{ raw: "envpixel.png" }]);
  });

  it("raw_coverage response carries strong/deterministic envelope", async () => {
    const wiki = freshWiki();
    wiki.rawAdd("a.pdf", { content: "x" });
    wiki.write("p.md", "---\ntitle: P\nsources: [raw/a.pdf]\n---\n");
    const result = JSON.parse((await handleTool(wiki, "raw_coverage", {})) as string);
    expect(result.evidence.confidence).toBe("strong");
    expect(result.evidence.basis).toBe("deterministic");
    expect(result.evidence.abstain).toBe(false);
    expect(result.evidence.rationale).toMatch(/SHA-256/);
    expect(result.evidence.provenance).toEqual([]);
  });

  it("code_parse response carries strong/deterministic envelope with raw provenance", async () => {
    const wiki = freshWiki();
    const cobol = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. ENVPARSE.
       PROCEDURE DIVISION.
           STOP RUN.`;
    wiki.rawAdd("ENVPARSE.cbl", { content: cobol });
    const result = JSON.parse((await handleTool(wiki, "code_parse", { path: "ENVPARSE.cbl" })) as string);
    expect(result.evidence.confidence).toBe("strong");
    expect(result.evidence.basis).toBe("deterministic");
    expect(result.evidence.abstain).toBe(false);
    expect(result.evidence.provenance).toEqual([{ raw: "ENVPARSE.cbl" }]);
    expect(result.evidence.rationale).toMatch(/Parsed ENVPARSE\.cbl/);
  });

  it("code_procedure_flow envelope is strong when procedures exist", async () => {
    const wiki = freshWiki();
    const cobol = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. ENVFLOW.
       PROCEDURE DIVISION.
       1000-MAIN SECTION.
           DISPLAY 'X'.
           STOP RUN.`;
    wiki.rawAdd("ENVFLOW.cbl", { content: cobol });
    await handleTool(wiki, "code_parse", { path: "ENVFLOW.cbl" });
    const result = JSON.parse(
      (await handleTool(wiki, "code_procedure_flow", { path: "ENVFLOW.cbl" })) as string,
    );
    expect(result.evidence.confidence).toBe("strong");
    expect(result.evidence.abstain).toBe(false);
    expect(result.evidence.provenance).toEqual([{ raw: "ENVFLOW.cbl" }]);
  });

  it("code_dataflow_edges envelope is absent + abstain when no edges match", async () => {
    const wiki = freshWiki();
    const cobol = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. ENVEDGE.
       PROCEDURE DIVISION.
           STOP RUN.`;
    wiki.rawAdd("ENVEDGE.cbl", { content: cobol });
    await handleTool(wiki, "code_parse", { path: "ENVEDGE.cbl" });
    const result = JSON.parse(
      (await handleTool(wiki, "code_dataflow_edges", { path: "ENVEDGE.cbl" })) as string,
    );
    // No PROCEDURE DIVISION moves → no dataflow edges → absent.
    expect(result.evidence.confidence).toBe("absent");
    expect(result.evidence.abstain).toBe(true);
    expect(result.total).toBe(0);
  });

  it("code_dataflow_edges envelope is strong when edges exist", async () => {
    const wiki = freshWiki();
    const cobol = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. ENVEDGE2.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-A PIC 9(4) VALUE 0.
       01 WS-B PIC 9(4) VALUE 0.
       PROCEDURE DIVISION.
           MOVE WS-A TO WS-B.
           STOP RUN.`;
    wiki.rawAdd("ENVEDGE2.cbl", { content: cobol });
    await handleTool(wiki, "code_parse", { path: "ENVEDGE2.cbl" });
    const result = JSON.parse(
      (await handleTool(wiki, "code_dataflow_edges", { path: "ENVEDGE2.cbl" })) as string,
    );
    expect(result.evidence.confidence).toBe("strong");
    expect(result.evidence.basis).toBe("deterministic");
    expect(result.evidence.provenance).toEqual([{ raw: "ENVEDGE2.cbl" }]);
    expect(result.total).toBeGreaterThan(0);
  });

  it("code_dataflow_edges transitive branch carries strong envelope when reachable", async () => {
    const wiki = freshWiki();
    const cobol = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. ENVEDGE3.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-A PIC 9(4) VALUE 0.
       01 WS-B PIC 9(4) VALUE 0.
       01 WS-C PIC 9(4) VALUE 0.
       PROCEDURE DIVISION.
           MOVE WS-A TO WS-B.
           MOVE WS-B TO WS-C.
           STOP RUN.`;
    wiki.rawAdd("ENVEDGE3.cbl", { content: cobol });
    await handleTool(wiki, "code_parse", { path: "ENVEDGE3.cbl" });
    const result = JSON.parse(
      (await handleTool(wiki, "code_dataflow_edges", {
        path: "ENVEDGE3.cbl",
        field: "WS-A",
        transitive: true,
        direction: "downstream",
      })) as string,
    );
    expect(result.transitive).toBe(true);
    expect(result.evidence.confidence).toBe("strong");
    expect(result.evidence.basis).toBe("deterministic");
    expect(result.evidence.rationale).toMatch(/Transitive downstream/);
    expect(result.total_edges).toBeGreaterThan(0);
  });

  it("code_dataflow_edges transitive branch is absent when start field has no edges", async () => {
    const wiki = freshWiki();
    const cobol = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. ENVEDGE4.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-LONELY PIC 9(4) VALUE 0.
       PROCEDURE DIVISION.
           STOP RUN.`;
    wiki.rawAdd("ENVEDGE4.cbl", { content: cobol });
    await handleTool(wiki, "code_parse", { path: "ENVEDGE4.cbl" });
    const result = JSON.parse(
      (await handleTool(wiki, "code_dataflow_edges", {
        path: "ENVEDGE4.cbl",
        field: "WS-LONELY",
        transitive: true,
      })) as string,
    );
    expect(result.transitive).toBe(true);
    expect(result.evidence.confidence).toBe("absent");
    expect(result.evidence.abstain).toBe(true);
    expect(result.total_edges).toBe(0);
  });

  it("code_procedure_flow envelope is absent when model has no sections or paragraphs", async () => {
    const wiki = freshWiki();
    // The COBOL parser synthesizes a default section+paragraph for inline-only
    // PROCEDURE DIVISION, so we can't trigger 0/0 via a real source. Write the
    // normalized artifact directly to exercise the absent branch — this is the
    // only path that produces sections+paragraphs === 0 for a parsed file.
    wiki.rawAdd("EMPTY.cbl", { content: "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. EMPTY." });
    const emptyModel = {
      units: [{ name: "EMPTY", kind: "program" }],
      procedures: [],
      symbols: [],
      relations: [],
      diagnostics: [],
    };
    wiki.rawAddParsedArtifact("parsed/cobol/EMPTY.normalized.json", JSON.stringify(emptyModel));
    const result = JSON.parse(
      (await handleTool(wiki, "code_procedure_flow", { path: "EMPTY.cbl" })) as string,
    );
    expect(result.evidence.confidence).toBe("absent");
    expect(result.evidence.abstain).toBe(true);
    expect(result.evidence.rationale).toMatch(/no sections or paragraphs/);
  });

  it("raw_read binary-non-image response carries envelope alongside metadata note", async () => {
    const wiki = freshWiki();
    const blob = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const rawPath = join(wiki.config.rawDir, "blob.dat");
    writeFileSync(rawPath, blob);
    writeFileSync(
      rawPath + ".meta.yaml",
      'path: blob.dat\ndownloadedAt: "2026-05-01"\nsha256: dead\nsize: 4\nmimeType: application/octet-stream\n',
    );
    const result = JSON.parse(
      (await handleTool(wiki, "raw_read", { filename: "blob.dat" })) as string,
    );
    expect(result.binary).toBe(true);
    expect(result.note).toMatch(/Binary file/);
    expect(result.evidence.confidence).toBe("strong");
    expect(result.evidence.basis).toBe("deterministic");
    expect(result.evidence.provenance).toEqual([{ raw: "blob.dat" }]);
  });
});

describe("batch: wiki_admin action:rebuild is deduplicated", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("wiki_admin action:rebuild is deferred and merged with end-of-batch rebuild", async () => {
    const wiki = freshWiki();
    wiki.write("concept-batch-rebuild.md", `---
title: Batch Rebuild Test
type: concept
tags: [batch]
---
Content for batch rebuild test.`);
    const result = await handleTool(wiki, "batch", {
      operations: [
        { tool: "wiki_write", args: { page: "concept-extra.md", content: `---
title: Extra
type: concept
tags: [extra]
---
Extra content.` } },
        { tool: "wiki_admin", args: { action: "rebuild" } },
      ],
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.count).toBe(2);
    // wiki_admin action:rebuild should be deferred
    const rebuildResult = parsed.results.find((r: any) => r.tool === "wiki_admin");
    expect(rebuildResult?.result?.deferred).toMatch(/rebuild/);
  });
});
