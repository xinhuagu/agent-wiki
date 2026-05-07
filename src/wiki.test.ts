/**
 * Tests for agent-wiki core engine.
 *
 * Covers: init, config, raw layer (add/list/read/verify), wiki CRUD,
 * search, lint, classify, synthesize, schemas, log, index, timeline.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Wiki, safePath } from "./wiki.js";
import type { WikiPage, LintReport, RawDocument } from "./wiki.js";

/** Helper: rawAdd for single file — asserts non-array return. */
function rawAddOne(wiki: Wiki, filename: string, opts: Parameters<Wiki["rawAdd"]>[1]): RawDocument {
  const result = wiki.rawAdd(filename, opts);
  if (Array.isArray(result)) throw new Error("Expected single RawDocument, got array");
  return result;
}

// ── Test helpers ─────────────────────────────────────────────────

const TEST_ROOT = join(import.meta.dirname ?? ".", "__test_workspace__");

function freshWiki(workspace?: string): Wiki {
  return Wiki.init(TEST_ROOT, workspace);
}

function cleanUp() {
  if (existsSync(TEST_ROOT)) {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  INIT & CONFIG
// ═══════════════════════════════════════════════════════════════════

describe("Wiki.init", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("creates wiki/, raw/, schemas/ directories", () => {
    freshWiki();
    expect(existsSync(join(TEST_ROOT, "wiki"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "raw"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "schemas"))).toBe(true);
  });

  it("creates default system pages (index, log, timeline)", () => {
    freshWiki();
    expect(existsSync(join(TEST_ROOT, "wiki", "index.md"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "wiki", "log.md"))).toBe(true);
    expect(existsSync(join(TEST_ROOT, "wiki", "timeline.md"))).toBe(true);
  });

  it("creates .agent-wiki.yaml config", () => {
    freshWiki();
    expect(existsSync(join(TEST_ROOT, ".agent-wiki.yaml"))).toBe(true);
  });

  it("creates default schema templates", () => {
    freshWiki();
    const schemasDir = join(TEST_ROOT, "schemas");
    for (const name of ["person", "concept", "event", "artifact", "comparison", "summary", "how-to", "note", "synthesis"]) {
      expect(existsSync(join(schemasDir, `${name}.md`))).toBe(true);
    }
  });

  it("creates .gitignore", () => {
    freshWiki();
    expect(existsSync(join(TEST_ROOT, ".gitignore"))).toBe(true);
  });
});

describe("Wiki.init with separate workspace", () => {
  const wsDir = join(TEST_ROOT, "data");

  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("puts data in workspace dir, config in root", () => {
    Wiki.init(TEST_ROOT, wsDir);
    expect(existsSync(join(TEST_ROOT, ".agent-wiki.yaml"))).toBe(true);
    expect(existsSync(join(wsDir, "wiki"))).toBe(true);
    expect(existsSync(join(wsDir, "raw"))).toBe(true);
    expect(existsSync(join(wsDir, "schemas"))).toBe(true);
  });

  it("creates .gitignore in workspace too", () => {
    Wiki.init(TEST_ROOT, wsDir);
    expect(existsSync(join(wsDir, ".gitignore"))).toBe(true);
  });
});

describe("Wiki.loadConfig", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("loads config from .agent-wiki.yaml", () => {
    const wiki = freshWiki();
    const cfg = wiki.config;
    expect(cfg.configRoot).toBe(TEST_ROOT);
    expect(cfg.wikiDir).toContain("wiki");
    expect(cfg.rawDir).toContain("raw");
    expect(cfg.schemasDir).toContain("schemas");
  });

  it("has default lint settings", () => {
    const wiki = freshWiki();
    expect(wiki.config.lint.checkOrphans).toBe(true);
    expect(wiki.config.lint.checkStaleDays).toBe(30);
    expect(wiki.config.lint.checkMissingSources).toBe(true);
    expect(wiki.config.lint.checkContradictions).toBe(true);
    expect(wiki.config.lint.checkIntegrity).toBe(true);
  });

  it("workspace override takes priority over config", () => {
    const wsDir = join(TEST_ROOT, "override_ws");
    Wiki.init(TEST_ROOT);
    const wiki = new Wiki(TEST_ROOT, wsDir);
    expect(wiki.config.workspace).toBe(wsDir);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  RAW LAYER
// ═══════════════════════════════════════════════════════════════════

describe("rawAdd", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("adds a text file with content", () => {
    const wiki = freshWiki();
    const doc = rawAddOne(wiki, "test.md", { content: "Hello world" });
    expect(doc.path).toBe("test.md");
    expect(doc.size).toBeGreaterThan(0);
    expect(doc.sha256).toHaveLength(64);
    expect(doc.mimeType).toBe("text/markdown");
  });

  it("creates .meta.yaml sidecar", () => {
    const wiki = freshWiki();
    wiki.rawAdd("data.json", { content: '{"key": "value"}' });
    expect(existsSync(join(wiki.config.rawDir, "data.json.meta.yaml"))).toBe(true);
  });

  it("stores correct SHA-256 hash", () => {
    const wiki = freshWiki();
    const content = "Test content for hashing";
    const doc = rawAddOne(wiki, "hash-test.txt", { content });
    const expected = createHash("sha256").update(content).digest("hex");
    expect(doc.sha256).toBe(expected);
  });

  it("rejects duplicate filenames (immutability)", () => {
    const wiki = freshWiki();
    wiki.rawAdd("once.txt", { content: "first" });
    expect(() => wiki.rawAdd("once.txt", { content: "second" }))
      .toThrow(/immutable/i);
  });

  it("requires content or sourcePath", () => {
    const wiki = freshWiki();
    expect(() => wiki.rawAdd("empty.txt", {}))
      .toThrow(/content|sourcePath/i);
  });

  it("accepts sourcePath (file copy)", () => {
    const wiki = freshWiki();
    const srcFile = join(TEST_ROOT, "src_file.txt");
    writeFileSync(srcFile, "copied content");
    const doc = rawAddOne(wiki, "copied.txt", { sourcePath: srcFile });
    expect(doc.size).toBeGreaterThan(0);
    const stored = readFileSync(join(wiki.config.rawDir, "copied.txt"), "utf-8");
    expect(stored).toBe("copied content");
  });

  it("stores optional metadata (sourceUrl, description, tags)", () => {
    const wiki = freshWiki();
    const doc = rawAddOne(wiki, "meta.txt", {
      content: "x",
      sourceUrl: "https://example.com",
      description: "A test file",
      tags: ["test", "demo"],
    });
    expect(doc.sourceUrl).toBe("https://example.com");
    expect(doc.description).toBe("A test file");
    expect(doc.tags).toEqual(["test", "demo"]);
  });
});

describe("rawAdd with autoVersion", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("auto-versions when file already exists", () => {
    const wiki = freshWiki();
    wiki.rawAdd("report.xlsx", { content: "v1 data" });
    const doc2 = rawAddOne(wiki, "report.xlsx", { content: "v2 data", autoVersion: true });
    expect(doc2.path).toBe("report_v2.xlsx");
  });

  it("increments to v3 when v2 exists", () => {
    const wiki = freshWiki();
    wiki.rawAdd("report.xlsx", { content: "v1" });
    wiki.rawAdd("report.xlsx", { content: "v2", autoVersion: true });
    const doc3 = rawAddOne(wiki, "report.xlsx", { content: "v3", autoVersion: true });
    expect(doc3.path).toBe("report_v3.xlsx");
  });

  it("creates v1 normally when file does not exist", () => {
    const wiki = freshWiki();
    const doc = rawAddOne(wiki, "new-file.xlsx", { content: "first", autoVersion: true });
    expect(doc.path).toBe("new-file.xlsx");
  });

  it("still rejects duplicates without autoVersion", () => {
    const wiki = freshWiki();
    wiki.rawAdd("once.txt", { content: "first" });
    expect(() => wiki.rawAdd("once.txt", { content: "second" })).toThrow(/immutable/i);
  });
});

describe("rawVersions", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("returns empty for non-existent file", () => {
    const wiki = freshWiki();
    const result = wiki.rawVersions("nope.xlsx");
    expect(result.versions).toEqual([]);
    expect(result.latest).toBeNull();
  });

  it("lists single version with latest", () => {
    const wiki = freshWiki();
    wiki.rawAdd("report.xlsx", { content: "v1" });
    const result = wiki.rawVersions("report.xlsx");
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0]!.version).toBe(1);
    expect(result.versions[0]!.path).toBe("report.xlsx");
    expect(result.latest).toBe("report.xlsx");
  });

  it("lists multiple versions sorted with latest pointing to highest", () => {
    const wiki = freshWiki();
    wiki.rawAdd("report.xlsx", { content: "v1" });
    wiki.rawAdd("report.xlsx", { content: "v2", autoVersion: true });
    wiki.rawAdd("report.xlsx", { content: "v3", autoVersion: true });
    const result = wiki.rawVersions("report.xlsx");
    expect(result.versions).toHaveLength(3);
    expect(result.versions[0]!.version).toBe(1);
    expect(result.versions[1]!.version).toBe(2);
    expect(result.versions[2]!.version).toBe(3);
    expect(result.versions[0]!.path).toBe("report.xlsx");
    expect(result.versions[1]!.path).toBe("report_v2.xlsx");
    expect(result.versions[2]!.path).toBe("report_v3.xlsx");
    expect(result.latest).toBe("report_v3.xlsx");
  });

  it("each version has metadata", () => {
    const wiki = freshWiki();
    wiki.rawAdd("data.csv", { content: "aaa" });
    wiki.rawAdd("data.csv", { content: "bbb", autoVersion: true });
    const result = wiki.rawVersions("data.csv");
    for (const v of result.versions) {
      expect(v.sha256).toHaveLength(64);
      expect(v.size).toBeGreaterThan(0);
      expect(v.downloadedAt).toBeTruthy();
    }
    expect(result.latest).toBe("data_v2.csv");
  });
});

describe("rawAdd with directory", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("imports all files from a directory", () => {
    const wiki = freshWiki();
    // Create a test directory with files inside the workspace
    const srcDir = join(TEST_ROOT, "import-src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "page1.html"), "<h1>Page 1</h1>");
    writeFileSync(join(srcDir, "page2.html"), "<h1>Page 2</h1>");
    writeFileSync(join(srcDir, "style.css"), "body {}");

    const docs = wiki.rawAdd("my-docs", { sourcePath: srcDir });
    expect(Array.isArray(docs)).toBe(true);
    expect((docs as any[]).length).toBe(3);
    expect(existsSync(join(wiki.config.rawDir, "my-docs", "page1.html"))).toBe(true);
    expect(existsSync(join(wiki.config.rawDir, "my-docs", "page2.html"))).toBe(true);
    expect(existsSync(join(wiki.config.rawDir, "my-docs", "style.css"))).toBe(true);
  });

  it("filters by pattern", () => {
    const wiki = freshWiki();
    const srcDir = join(TEST_ROOT, "import-filtered");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "page.html"), "<h1>Page</h1>");
    writeFileSync(join(srcDir, "data.json"), "{}");
    writeFileSync(join(srcDir, "style.css"), "body {}");

    const docs = wiki.rawAdd("filtered", { sourcePath: srcDir, pattern: "*.html" });
    expect(Array.isArray(docs)).toBe(true);
    expect((docs as any[]).length).toBe(1);
    expect((docs as any[])[0].path).toBe(join("filtered", "page.html"));
  });

  it("supports brace expansion pattern", () => {
    const wiki = freshWiki();
    const srcDir = join(TEST_ROOT, "import-brace");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "page.html"), "<h1>Page</h1>");
    writeFileSync(join(srcDir, "style.css"), "body {}");
    writeFileSync(join(srcDir, "data.json"), "{}");

    const docs = wiki.rawAdd("brace", { sourcePath: srcDir, pattern: "*.{html,css}" });
    expect(Array.isArray(docs)).toBe(true);
    expect((docs as any[]).length).toBe(2);
  });

  it("preserves subdirectory structure", () => {
    const wiki = freshWiki();
    const srcDir = join(TEST_ROOT, "import-nested");
    mkdirSync(join(srcDir, "sub"), { recursive: true });
    writeFileSync(join(srcDir, "index.html"), "<h1>Root</h1>");
    writeFileSync(join(srcDir, "sub", "child.html"), "<h1>Child</h1>");

    const docs = wiki.rawAdd("nested", { sourcePath: srcDir });
    expect(Array.isArray(docs)).toBe(true);
    expect((docs as any[]).length).toBe(2);
    expect(existsSync(join(wiki.config.rawDir, "nested", "index.html"))).toBe(true);
    expect(existsSync(join(wiki.config.rawDir, "nested", "sub", "child.html"))).toBe(true);
  });

  it("throws when directory is empty", () => {
    const wiki = freshWiki();
    const srcDir = join(TEST_ROOT, "import-empty");
    mkdirSync(srcDir, { recursive: true });

    expect(() => wiki.rawAdd("empty", { sourcePath: srcDir }))
      .toThrow(/no files found/i);
  });

  it("throws when pattern matches nothing", () => {
    const wiki = freshWiki();
    const srcDir = join(TEST_ROOT, "import-nomatch");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "data.json"), "{}");

    expect(() => wiki.rawAdd("nomatch", { sourcePath: srcDir, pattern: "*.html" }))
      .toThrow(/no files found.*\*\.html/i);
  });

  it("respects security for directory imports", () => {
    const wiki = freshWiki();
    const outsideDir = join(TEST_ROOT, "..", "__outside_dir__");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "secret.txt"), "no");

    try {
      expect(() => wiki.rawAdd("stolen", { sourcePath: outsideDir }))
        .toThrow(/outside allowed directories/i);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("generates metadata sidecar for each imported file", () => {
    const wiki = freshWiki();
    const srcDir = join(TEST_ROOT, "import-meta");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "a.txt"), "hello");
    writeFileSync(join(srcDir, "b.txt"), "world");

    wiki.rawAdd("meta-dir", { sourcePath: srcDir, tags: ["test"] });
    expect(existsSync(join(wiki.config.rawDir, "meta-dir", "a.txt.meta.yaml"))).toBe(true);
    expect(existsSync(join(wiki.config.rawDir, "meta-dir", "b.txt.meta.yaml"))).toBe(true);
  });

  it("single file still works with sourcePath", () => {
    const wiki = freshWiki();
    const srcFile = join(TEST_ROOT, "single.txt");
    writeFileSync(srcFile, "just a file");

    const doc = wiki.rawAdd("single.txt", { sourcePath: srcFile });
    expect(Array.isArray(doc)).toBe(false);
    expect((doc as any).path).toBe("single.txt");
  });
});

describe("rawList", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("returns empty array when no raw files", () => {
    const wiki = freshWiki();
    expect(wiki.rawList()).toEqual([]);
  });

  it("lists added raw documents", () => {
    const wiki = freshWiki();
    wiki.rawAdd("a.txt", { content: "aaa" });
    wiki.rawAdd("b.md", { content: "bbb" });
    const docs = wiki.rawList();
    expect(docs).toHaveLength(2);
    expect(docs.map(d => d.path).sort()).toEqual(["a.txt", "b.md"]);
  });
});

describe("rawCoverage", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("reports full coverage when all raw files are referenced via frontmatter", () => {
    const wiki = freshWiki();
    wiki.rawAdd("paper.pdf", { content: "pdf bytes" });
    wiki.rawAdd("notes.md", { content: "notes" });
    wiki.write("concept-x.md",
      "---\ntitle: X\ntype: concept\nsources: [raw/paper.pdf, notes.md]\n---\nBody");

    const r = wiki.rawCoverage();
    expect(r.totalRaw).toBe(2);
    expect(r.coveredRaw).toBe(2);
    expect(r.uncoveredRaw).toBe(0);
    expect(r.coverageRatio).toBe(1);
    expect(r.uncovered).toEqual([]);
  });

  it("lists uncovered raw files", () => {
    const wiki = freshWiki();
    wiki.rawAdd("covered.pdf", { content: "x" });
    wiki.rawAdd("orphan-a.pdf", { content: "y" });
    wiki.rawAdd("orphan-b.txt", { content: "z" });
    wiki.write("p.md", "---\ntitle: P\ntype: concept\nsources: [raw/covered.pdf]\n---\n");

    const r = wiki.rawCoverage();
    expect(r.totalRaw).toBe(3);
    expect(r.coveredRaw).toBe(1);
    expect(r.uncoveredRaw).toBe(2);
    expect(r.uncovered.map(u => u.path).sort()).toEqual(["orphan-a.pdf", "orphan-b.txt"]);
  });

  it("matches inline body references to raw/", () => {
    const wiki = freshWiki();
    wiki.rawAdd("inline.pdf", { content: "x" });
    wiki.write("p.md", "---\ntitle: P\ntype: concept\n---\nSee raw/inline.pdf for details.");

    const r = wiki.rawCoverage();
    expect(r.uncoveredRaw).toBe(0);
  });

  it("strips trailing punctuation from inline raw/ references", () => {
    const wiki = freshWiki();
    wiki.rawAdd("a.pdf", { content: "a" });
    wiki.rawAdd("b.pdf", { content: "b" });
    wiki.rawAdd("c.md", { content: "c" });
    wiki.write("p.md",
      "---\ntitle: P\ntype: concept\n---\nSee raw/a.pdf, raw/b.pdf. And raw/c.md:");

    const r = wiki.rawCoverage();
    expect(r.uncoveredRaw).toBe(0);
  });

  it("matches by sourceUrl when frontmatter source is a URL", () => {
    const wiki = freshWiki();
    wiki.rawAdd("article.md", { content: "x", sourceUrl: "https://example.com/article" });
    wiki.write("p.md", "---\ntitle: P\ntype: concept\nsources: [https://example.com/article]\n---\n");

    const r = wiki.rawCoverage();
    expect(r.coveredRaw).toBe(1);
    expect(r.uncoveredRaw).toBe(0);
  });

  it("matches URLs that differ only by trailing slash or scheme/host case", () => {
    const wiki = freshWiki();
    wiki.rawAdd("a.md", { content: "a", sourceUrl: "https://Example.com/Article/" });
    wiki.rawAdd("b.md", { content: "b", sourceUrl: "https://example.com/other" });
    wiki.write("p.md",
      "---\ntitle: P\ntype: concept\nsources: [https://example.com/Article, HTTPS://example.com/other/]\n---\n");

    const r = wiki.rawCoverage();
    expect(r.coveredRaw).toBe(2);
    expect(r.uncoveredRaw).toBe(0);
  });

  it("excludes raw/parsed/ artifacts from coverage", () => {
    const wiki = freshWiki();
    wiki.rawAdd("source.cbl", { content: "PROGRAM-ID. X." });
    // Simulate a parsed artifact by writing directly under raw/parsed/
    const parsedDir = join(wiki.config.rawDir, "parsed", "cobol");
    mkdirSync(parsedDir, { recursive: true });
    writeFileSync(join(parsedDir, "X.ast.json"), "{}");
    wiki.write("p.md", "---\ntitle: P\ntype: concept\nsources: [raw/source.cbl]\n---\n");

    const r = wiki.rawCoverage();
    expect(r.totalRaw).toBe(1);
    expect(r.uncoveredRaw).toBe(0);
  });

  it("respects limit and sets truncated flag", () => {
    const wiki = freshWiki();
    for (let i = 0; i < 5; i++) wiki.rawAdd(`f${i}.txt`, { content: String(i) });

    const r = wiki.rawCoverage({ limit: 2 });
    expect(r.uncoveredRaw).toBe(5);
    expect(r.uncovered).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it("sorts by largest when requested", () => {
    const wiki = freshWiki();
    wiki.rawAdd("small.txt", { content: "a" });
    wiki.rawAdd("big.txt", { content: "a".repeat(1000) });
    wiki.rawAdd("medium.txt", { content: "a".repeat(100) });

    const r = wiki.rawCoverage({ sort: "largest" });
    expect(r.uncovered.map(u => u.path)).toEqual(["big.txt", "medium.txt", "small.txt"]);
  });

  it("filters by tag", () => {
    const wiki = freshWiki();
    wiki.rawAdd("tagged.txt", { content: "x", tags: ["keep"] });
    wiki.rawAdd("untagged.txt", { content: "y" });

    const r = wiki.rawCoverage({ tag: "keep" });
    expect(r.totalRaw).toBe(1);
    expect(r.uncovered.map(u => u.path)).toEqual(["tagged.txt"]);
  });

  it("returns coverageRatio 1 on empty raw/", () => {
    const wiki = freshWiki();
    const r = wiki.rawCoverage();
    expect(r.totalRaw).toBe(0);
    expect(r.coverageRatio).toBe(1);
  });
});

describe("rawRead", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("reads text file content", async () => {
    const wiki = freshWiki();
    wiki.rawAdd("readme.md", { content: "# Hello" });
    const result = await wiki.rawRead("readme.md");
    expect(result).not.toBeNull();
    expect(result!.binary).toBe(false);
    expect(result!.content).toBe("# Hello");
    expect(result!.meta).not.toBeNull();
  });

  it("returns null for non-existent file", async () => {
    const wiki = freshWiki();
    const result = await wiki.rawRead("nonexistent.md");
    expect(result).toBeNull();
  });

  it("handles JSON as text", async () => {
    const wiki = freshWiki();
    wiki.rawAdd("data.json", { content: '{"x":1}' });
    const result = await wiki.rawRead("data.json");
    expect(result!.binary).toBe(false);
    expect(result!.content).toBe('{"x":1}');
  });

  it("returns binary=true with imageData for image files", async () => {
    const wiki = freshWiki();
    // Write a fake PNG (just bytes, not a real image)
    const rawPath = join(wiki.config.rawDir, "photo.png");
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(rawPath, imageBytes);
    writeFileSync(rawPath + ".meta.yaml", `path: photo.png\ndownloadedAt: "2024-01-01"\nsha256: abcd\nsize: 4\nmimeType: image/png\n`);
    const result = await wiki.rawRead("photo.png");
    expect(result!.binary).toBe(true);
    expect(result!.content).toBeNull();
    expect(result!.imageData).toBeDefined();
    expect(result!.imageData!.mimeType).toBe("image/png");
    expect(result!.imageData!.data).toBe(imageBytes.toString("base64"));
  });

  it("returns note for oversized image files", async () => {
    const wiki = freshWiki();
    const rawPath = join(wiki.config.rawDir, "big.jpg");
    // Write a minimal file but fake the size in meta to exceed 10MB
    writeFileSync(rawPath, Buffer.from([0xff, 0xd8]));
    const bigSize = 11 * 1024 * 1024;
    writeFileSync(rawPath + ".meta.yaml", `path: big.jpg\ndownloadedAt: "2024-01-01"\nsha256: abcd\nsize: ${bigSize}\nmimeType: image/jpeg\n`);
    // Overwrite with actual large buffer to trigger size check
    writeFileSync(rawPath, Buffer.alloc(bigSize));
    const result = await wiki.rawRead("big.jpg");
    expect(result!.binary).toBe(true);
    expect(result!.imageData).toBeUndefined();
    expect(result!.note).toMatch(/too large/i);
  });
});

// ── PDF extraction & pages parameter ──────────────────────────────

/** Generate a minimal valid PDF with N pages, each containing "Page X" text. */
function makePdf(numPages: number): Buffer {
  const objects: Array<{ num: number; body: string }> = [];
  let objNum = 1;
  const catalogNum = objNum++;
  const pagesNum = objNum++;
  const fontNum = objNum++;
  const pageNums: number[] = [];
  const contentNums: number[] = [];

  for (let i = 0; i < numPages; i++) {
    pageNums.push(objNum++);
    contentNums.push(objNum++);
  }

  objects.push({ num: catalogNum, body: `<< /Type /Catalog /Pages ${pagesNum} 0 R >>` });
  objects.push({ num: pagesNum, body: `<< /Type /Pages /Kids [${pageNums.map(n => n + " 0 R").join(" ")}] /Count ${numPages} >>` });
  objects.push({ num: fontNum, body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>` });

  for (let i = 0; i < numPages; i++) {
    const text = `Page ${i + 1}`;
    const stream = `BT /F1 12 Tf 100 700 Td (${text}) Tj ET`;
    objects.push({ num: pageNums[i]!, body: `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Contents ${contentNums[i]} 0 R /Resources << /Font << /F1 ${fontNum} 0 R >> >> >>` });
    objects.push({ num: contentNums[i]!, body: `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream` });
  }

  objects.sort((a, b) => a.num - b.num);
  let pdf = "%PDF-1.4\n";
  const offsets: Array<{ num: number; offset: number }> = [];
  for (const obj of objects) {
    offsets.push({ num: obj.num, offset: pdf.length });
    pdf += `${obj.num} 0 obj\n${obj.body}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const { offset } of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}

/** Write a synthetic PDF into the wiki's raw/ directory with a .meta.yaml sidecar. */
function placePdf(wiki: Wiki, filename: string, numPages: number) {
  const buf = makePdf(numPages);
  const rawPath = join(wiki.config.rawDir, filename);
  writeFileSync(rawPath, buf);
  const sha = createHash("sha256").update(buf).digest("hex");
  writeFileSync(rawPath + ".meta.yaml",
    `path: ${filename}\ndownloadedAt: "2024-01-01"\nsha256: ${sha}\nsize: ${buf.length}\nmimeType: application/pdf\n`);
}

describe("rawRead — PDF extraction", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("extracts text from a small PDF", async () => {
    const wiki = freshWiki();
    placePdf(wiki, "small.pdf", 3);
    const result = await wiki.rawRead("small.pdf");
    expect(result).not.toBeNull();
    expect(result!.binary).toBe(false);
    expect(result!.content).toContain("Page 1");
    expect(result!.content).toContain("Page 2");
    expect(result!.content).toContain("Page 3");
  });

  it("extracts specific pages with pages parameter", async () => {
    const wiki = freshWiki();
    placePdf(wiki, "multi.pdf", 5);
    const result = await wiki.rawRead("multi.pdf", { pages: "2-3" });
    expect(result!.binary).toBe(false);
    expect(result!.content).toContain("Page 2");
    expect(result!.content).toContain("Page 3");
    expect(result!.content).not.toContain("Page 1");
    expect(result!.content).not.toContain("Page 4");
    expect(result!.content).not.toContain("Page 5");
  });

  it("extracts a single page with pages parameter", async () => {
    const wiki = freshWiki();
    placePdf(wiki, "single.pdf", 5);
    const result = await wiki.rawRead("single.pdf", { pages: "3" });
    expect(result!.binary).toBe(false);
    expect(result!.content).toContain("Page 3");
    expect(result!.content).not.toContain("Page 1");
    expect(result!.content).not.toContain("Page 5");
  });

  it("supports comma-separated page ranges", async () => {
    const wiki = freshWiki();
    placePdf(wiki, "combo.pdf", 10);
    const result = await wiki.rawRead("combo.pdf", { pages: "1-2,5,8-9" });
    expect(result!.binary).toBe(false);
    for (const p of [1, 2, 5, 8, 9]) {
      expect(result!.content).toContain(`Page ${p}`);
    }
    for (const p of [3, 4, 6, 7, 10]) {
      expect(result!.content).not.toContain(`Page ${p}`);
    }
  });

  it("returns 'no pages matched' for out-of-range page", async () => {
    const wiki = freshWiki();
    placePdf(wiki, "bounds.pdf", 3);
    const result = await wiki.rawRead("bounds.pdf", { pages: "999" });
    expect(result!.binary).toBe(false);
    expect(result!.content).toContain("no pages matched");
  });

  it("clamps range end beyond total pages", async () => {
    const wiki = freshWiki();
    placePdf(wiki, "clamp.pdf", 3);
    const result = await wiki.rawRead("clamp.pdf", { pages: "2-100" });
    expect(result!.binary).toBe(false);
    expect(result!.content).toContain("Page 2");
    expect(result!.content).toContain("Page 3");
    expect(result!.content).not.toContain("Page 1");
  });

  it("returns 'no pages matched' for completely invalid range", async () => {
    const wiki = freshWiki();
    placePdf(wiki, "invalid.pdf", 3);
    const result = await wiki.rawRead("invalid.pdf", { pages: "abc" });
    expect(result!.binary).toBe(false);
    expect(result!.content).toContain("no pages matched");
  });

  it("includes page header when pages parameter is used", async () => {
    const wiki = freshWiki();
    placePdf(wiki, "header.pdf", 5);
    const result = await wiki.rawRead("header.pdf", { pages: "1-2" });
    expect(result!.content).toMatch(/\[Pages 1-2 of 5\]/);
  });

  it("omits page header when reading all pages", async () => {
    const wiki = freshWiki();
    placePdf(wiki, "noheader.pdf", 3);
    const result = await wiki.rawRead("noheader.pdf");
    expect(result!.content).not.toContain("[Pages");
  });

  it("extracts all pages from a 25-page PDF without pages parameter", async () => {
    const wiki = freshWiki();
    placePdf(wiki, "large.pdf", 25);
    const result = await wiki.rawRead("large.pdf");
    expect(result!.binary).toBe(false);
    for (let p = 1; p <= 25; p++) {
      expect(result!.content).toContain(`Page ${p}`);
    }
  });

  it("preserves page ordering in output", async () => {
    const wiki = freshWiki();
    placePdf(wiki, "order.pdf", 5);
    const result = await wiki.rawRead("order.pdf", { pages: "3,1,5" });
    const content = result!.content!;
    const pos1 = content.indexOf("Page 1");
    const pos3 = content.indexOf("Page 3");
    const pos5 = content.indexOf("Page 5");
    // Pages should appear in ascending order regardless of input order
    expect(pos1).toBeLessThan(pos3);
    expect(pos3).toBeLessThan(pos5);
  });

  it("handles whitespace in page range", async () => {
    const wiki = freshWiki();
    placePdf(wiki, "ws.pdf", 5);
    const result = await wiki.rawRead("ws.pdf", { pages: " 2 - 4 " });
    expect(result!.content).toContain("Page 2");
    expect(result!.content).toContain("Page 3");
    expect(result!.content).toContain("Page 4");
    expect(result!.content).not.toContain("Page 1");
    expect(result!.content).not.toContain("Page 5");
  });

  it("clamps page 0 to page 1", async () => {
    const wiki = freshWiki();
    placePdf(wiki, "zero.pdf", 3);
    const result = await wiki.rawRead("zero.pdf", { pages: "0-2" });
    expect(result!.content).toContain("Page 1");
    expect(result!.content).toContain("Page 2");
  });

  it("pages parameter is ignored for non-PDF documents", async () => {
    const wiki = freshWiki();
    wiki.rawAdd("text.md", { content: "# Hello" });
    const result = await wiki.rawRead("text.md", { pages: "1-2" });
    expect(result!.binary).toBe(false);
    expect(result!.content).toBe("# Hello");
  });
});

describe("rawVerify", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("returns empty for empty raw dir", () => {
    const wiki = freshWiki();
    expect(wiki.rawVerify()).toEqual([]);
  });

  it("reports ok for valid files", () => {
    const wiki = freshWiki();
    wiki.rawAdd("valid.txt", { content: "intact" });
    const results = wiki.rawVerify();
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("ok");
  });

  it("detects corrupted files", () => {
    const wiki = freshWiki();
    wiki.rawAdd("tamper.txt", { content: "original" });
    // Tamper with the file
    writeFileSync(join(wiki.config.rawDir, "tamper.txt"), "modified!");
    const results = wiki.rawVerify();
    expect(results[0]!.status).toBe("corrupted");
  });

  it("detects missing metadata", () => {
    const wiki = freshWiki();
    // Write a raw file without using rawAdd (no meta sidecar)
    writeFileSync(join(wiki.config.rawDir, "orphan.txt"), "no meta");
    const results = wiki.rawVerify();
    const orphan = results.find(r => r.path === "orphan.txt");
    expect(orphan).toBeDefined();
    expect(orphan!.status).toBe("missing-meta");
  });
});

// ═══════════════════════════════════════════════════════════════════
//  WIKI LAYER — CRUD
// ═══════════════════════════════════════════════════════════════════

describe("wiki.write & wiki.read", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("writes and reads a page with frontmatter", () => {
    const wiki = freshWiki();
    const content = `---
title: Test Page
type: concept
tags: [test, demo]
---

# Test Page

This is a test.
`;
    wiki.write("concept-test.md", content);
    const page = wiki.read("concept-test.md");
    expect(page).not.toBeNull();
    expect(page!.title).toBe("Test Page");
    expect(page!.type).toBe("concept");
    expect(page!.tags).toEqual(["test", "demo"]);
    expect(page!.content).toContain("This is a test.");
  });

  it("auto-injects created/updated timestamps", () => {
    const wiki = freshWiki();
    wiki.write("timestamped.md", "---\ntitle: Time\n---\nBody");
    const page = wiki.read("timestamped.md");
    expect(page!.created).toBeDefined();
    expect(page!.updated).toBeDefined();
  });

  it("preserves created time on update", () => {
    const wiki = freshWiki();
    wiki.write("update-me.md", "---\ntitle: V1\n---\nFirst version");
    const v1 = wiki.read("update-me.md");
    const created1 = v1!.created;

    // Wait a tick so timestamps differ
    wiki.write("update-me.md", "---\ntitle: V2\n---\nSecond version");
    const v2 = wiki.read("update-me.md");
    expect(v2!.created).toBe(created1);
    expect(v2!.title).toBe("V2");
  });

  it("returns null for non-existent page", () => {
    const wiki = freshWiki();
    expect(wiki.read("nonexistent.md")).toBeNull();
  });

  it("auto-appends .md when reading", () => {
    const wiki = freshWiki();
    wiki.write("auto-ext.md", "---\ntitle: Auto\n---\nBody");
    const page = wiki.read("auto-ext");
    expect(page).not.toBeNull();
    expect(page!.title).toBe("Auto");
  });

  it("extracts [[links]] from body", () => {
    const wiki = freshWiki();
    wiki.write("linker.md", "---\ntitle: Linker\n---\nSee [[concept-a]] and [[concept-b]].");
    const page = wiki.read("linker.md");
    expect(page!.links).toEqual(["concept-a", "concept-b"]);
  });

  describe("evidence-first phase 2a — write classification", () => {
    it("grounded: page with non-empty sources is left alone", () => {
      const wiki = freshWiki();
      wiki.write("g.md", "---\ntitle: G\nsources: [raw/x.md]\n---\nGrounded body.");
      const page = wiki.read("g.md");
      expect(page!.frontmatter.unsupported).toBeUndefined();
      expect(page!.frontmatter.legacyUnsupported).toBeUndefined();
    });

    it("synthesis (flag): page with synthesis: true is left alone", () => {
      const wiki = freshWiki();
      wiki.write("s.md", "---\ntitle: S\nsynthesis: true\n---\nAggregated.");
      const page = wiki.read("s.md");
      expect(page!.frontmatter.unsupported).toBeUndefined();
      expect(page!.frontmatter.synthesis).toBe(true);
    });

    it("synthesis (legacy type field): page with type: synthesis is left alone", () => {
      const wiki = freshWiki();
      wiki.write("legacy-synth.md", "---\ntitle: L\ntype: synthesis\n---\nAggregated.");
      const page = wiki.read("legacy-synth.md");
      expect(page!.frontmatter.unsupported).toBeUndefined();
    });

    it("unsupported: page with no sources and no synthesis flag is stamped", () => {
      const wiki = freshWiki();
      wiki.write("u.md", "---\ntitle: U\n---\nMy assertion.");
      const page = wiki.read("u.md");
      expect(page!.frontmatter.unsupported).toBe(true);
    });

    it("clears unsupported: true when a follow-up write adds sources", () => {
      const wiki = freshWiki();
      wiki.write("x.md", "---\ntitle: X\n---\nFirst write.");
      const first = wiki.read("x.md");
      expect(first!.frontmatter.unsupported).toBe(true);
      wiki.write("x.md", "---\ntitle: X\nsources: [raw/p.md]\n---\nNow grounded.");
      const second = wiki.read("x.md");
      expect(second!.frontmatter.unsupported).toBeUndefined();
    });

    it("does not stamp unsupported on legacyUnsupported migrated pages", () => {
      const wiki = freshWiki();
      // Migration write — sets legacyUnsupported. The classifier must
      // respect this and not pile on a separate `unsupported` flag.
      wiki.write("legacy.md", "---\ntitle: L\nlegacyUnsupported: true\n---\nOld page.");
      const page = wiki.read("legacy.md");
      expect(page!.frontmatter.legacyUnsupported).toBe(true);
      expect(page!.frontmatter.unsupported).toBeUndefined();
    });

    it("does not stamp unsupported on system pages (index/log/timeline)", () => {
      const wiki = freshWiki();
      // index.md is auto-generated but the classifier shouldn't stamp it
      // anyway — it's synthesis by construction.
      wiki.rebuildIndex();
      const idx = wiki.read("index.md");
      expect(idx?.frontmatter.unsupported).toBeUndefined();
    });

    it("dedupes telemetry: re-editing an unsupported page does not fire a second event", async () => {
      const wiki = freshWiki();
      const { readWriteLog } = await import("./evidence-write-log.js");
      wiki.write("notes.md", "---\ntitle: N\n---\nFirst draft.");
      wiki.write("notes.md", "---\ntitle: N\n---\nSecond draft.");
      wiki.write("notes.md", "---\ntitle: N\n---\nThird draft.");
      const events = readWriteLog(wiki.config.workspace);
      // Three writes, but only the first one is a transition into
      // unsupported — telemetry should record exactly one event.
      expect(events.filter((e) => e.page === "notes.md")).toHaveLength(1);
    });

    it("recovers from a corrupted existing-page frontmatter (overwrites without crashing)", () => {
      const wiki = freshWiki();
      // Write garbage YAML to a page file directly. wiki.write must not
      // crash when this overwrites — it should treat existing frontmatter
      // as absent, write fresh content, and stamp classification normally.
      const fullPath = join(wiki.config.wikiDir, "junk.md");
      writeFileSync(fullPath, "---\nthis is :: not valid:\n  - yaml: [unbalanced\n---\nbody.");
      expect(() =>
        wiki.write("junk.md", "---\ntitle: Junk\n---\nClean body.")
      ).not.toThrow();
      const after = wiki.read("junk.md");
      expect(after?.frontmatter.title).toBe("Junk");
      expect(after?.frontmatter.unsupported).toBe(true);
    });

    it("preserves legacyUnsupported flag across edits and stays silent on telemetry", async () => {
      const wiki = freshWiki();
      const { readWriteLog } = await import("./evidence-write-log.js");
      // Migration tags an existing page as legacy.
      wiki.write("opinion.md", "---\ntitle: O\nlegacyUnsupported: true\n---\nOld take.");
      // User re-edits without including legacyUnsupported in their content —
      // the on-disk flag must be preserved and `unsupported: true` must NOT
      // be stamped (otherwise we lose the grandfather audit trail).
      wiki.write("opinion.md", "---\ntitle: O\n---\nRevised take.");
      const after = wiki.read("opinion.md");
      expect(after?.frontmatter.legacyUnsupported).toBe(true);
      expect(after?.frontmatter.unsupported).toBeUndefined();
      // No telemetry should fire for legacy edits.
      const events = readWriteLog(wiki.config.workspace);
      expect(events.filter((e) => e.page === "opinion.md")).toHaveLength(0);
    });
  });

  describe("evidence-first phase 2b — hard rejection of unsupported writes", () => {
    // The reject mode is opt-in via `evidence.rejectUnsupportedWrites`. The
    // setupRejectMode helper mutates the config in-place after init —
    // simpler than threading a config option through Wiki.init for these
    // tests since the production toggle is the same surface (env var or
    // .agent-wiki.yaml are read at config-load time).
    function rejectWiki(): Wiki {
      const wiki = freshWiki();
      wiki.config.evidence.rejectUnsupportedWrites = true;
      return wiki;
    }

    it("passes through grounded writes (sources non-empty)", () => {
      const wiki = rejectWiki();
      expect(() =>
        wiki.write("ok.md", "---\ntitle: G\nsources: [raw/x.md]\n---\nGrounded."),
      ).not.toThrow();
      expect(wiki.read("ok.md")?.frontmatter.unsupported).toBeUndefined();
    });

    it("passes through synthesis writes (synthesis: true)", () => {
      const wiki = rejectWiki();
      expect(() =>
        wiki.write("syn.md", "---\ntitle: S\nsynthesis: true\n---\nAggregated."),
      ).not.toThrow();
    });

    it("passes through synthesis writes (type: synthesis)", () => {
      const wiki = rejectWiki();
      expect(() =>
        wiki.write("legacy-syn.md", "---\ntitle: S\ntype: synthesis\n---\nAggregated."),
      ).not.toThrow();
    });

    it("rejects fresh unsupported writes with a clear error", () => {
      const wiki = rejectWiki();
      expect(() =>
        wiki.write("blocked.md", "---\ntitle: B\n---\nNo sources."),
      ).toThrow(/wiki_write rejected/);
      expect(wiki.read("blocked.md")).toBeNull();
    });

    it("logs rejected attempts to telemetry with rejected: true and rejectReason: 'fresh'", async () => {
      const wiki = rejectWiki();
      const { readWriteLog } = await import("./evidence-write-log.js");
      try {
        wiki.write("blocked.md", "---\ntitle: B\n---\nNothing.");
      } catch {
        // expected
      }
      const events = readWriteLog(wiki.config.workspace);
      const blocked = events.find((e) => e.page === "blocked.md");
      expect(blocked?.rejected).toBe(true);
      expect(blocked?.rejectReason).toBe("fresh");
    });

    it("logs rejectReason: 'legacy' on blocked re-edits of legacyUnsupported pages", async () => {
      const wiki = rejectWiki();
      const { readWriteLog } = await import("./evidence-write-log.js");
      wiki.config.evidence.rejectUnsupportedWrites = false;
      wiki.write("legacy-tel.md", "---\ntitle: L\nlegacyUnsupported: true\n---\nOld.");
      wiki.config.evidence.rejectUnsupportedWrites = true;
      try {
        wiki.write("legacy-tel.md", "---\ntitle: L\n---\nStill no sources.");
      } catch {
        // expected
      }
      const events = readWriteLog(wiki.config.workspace);
      // .filter(...).at(-1) instead of .findLast() — the latter requires
      // lib: ES2023, but the project pins ES2022. Preserves "last matching
      // event" semantics so the test still works if a future change starts
      // emitting telemetry for legacy seed writes.
      const legacy = events.filter((e) => e.page === "legacy-tel.md").at(-1);
      expect(legacy?.rejected).toBe(true);
      expect(legacy?.rejectReason).toBe("legacy");
    });

    it("rejects re-edits of legacyUnsupported pages that don't resolve the legacy status", () => {
      const wiki = rejectWiki();
      // Seed a legacy page in warn mode (so the seed itself isn't rejected),
      // then flip to reject mode to exercise the legacy-update path.
      wiki.config.evidence.rejectUnsupportedWrites = false;
      wiki.write("legacy.md", "---\ntitle: L\nlegacyUnsupported: true\n---\nOld.");
      wiki.config.evidence.rejectUnsupportedWrites = true;
      // Re-edit without sources or synthesis — must reject. The legacy
      // flag is a deferral, not a permanent grant: editing forces a choice.
      expect(() =>
        wiki.write("legacy.md", "---\ntitle: L\n---\nRevised legacy text."),
      ).toThrow(/legacyUnsupported/);
      // The on-disk page is unchanged (writeFileSync is reached only after
      // the throw site, so the legacy flag is still there for next time).
      // Asserting on the body too — not just the flag — guards against
      // someone moving the throw below the write in the future.
      const after = wiki.read("legacy.md");
      expect(after?.frontmatter.legacyUnsupported).toBe(true);
      expect(after?.content).toContain("Old.");
      expect(after?.content).not.toContain("Revised legacy text.");
    });

    it("clears legacyUnsupported when adding sources transitions a legacy page to grounded", () => {
      const wiki = rejectWiki();
      // Seed legacy in warn mode (reject mode would block the seed write
      // itself since it's an unsupported submission with legacy flag).
      wiki.config.evidence.rejectUnsupportedWrites = false;
      wiki.write("legacy.md", "---\ntitle: L\nlegacyUnsupported: true\n---\nOld.");
      wiki.config.evidence.rejectUnsupportedWrites = true;
      wiki.write("legacy.md", "---\ntitle: L\nsources: [raw/x.md]\n---\nNow grounded.");
      const after = wiki.read("legacy.md");
      expect(after?.frontmatter.legacyUnsupported).toBeUndefined();
      expect(after?.frontmatter.unsupported).toBeUndefined();
    });

    it("clears legacyUnsupported when adding synthesis: true transitions a legacy page", () => {
      const wiki = rejectWiki();
      wiki.config.evidence.rejectUnsupportedWrites = false;
      wiki.write("legacy.md", "---\ntitle: L\nlegacyUnsupported: true\n---\nOld.");
      wiki.config.evidence.rejectUnsupportedWrites = true;
      wiki.write("legacy.md", "---\ntitle: L\nsynthesis: true\n---\nNow synthesis.");
      const after = wiki.read("legacy.md");
      expect(after?.frontmatter.legacyUnsupported).toBeUndefined();
      expect(after?.frontmatter.synthesis).toBe(true);
    });

    it("default mode (warn) is unchanged — fresh unsupported writes still pass with `unsupported: true`", () => {
      // Sanity: rejectUnsupportedWrites defaults to false. Phase 2a behavior intact.
      const wiki = freshWiki();
      expect(wiki.config.evidence.rejectUnsupportedWrites).toBe(false);
      wiki.write("warned.md", "---\ntitle: W\n---\nUnsupported.");
      expect(wiki.read("warned.md")?.frontmatter.unsupported).toBe(true);
    });

    it("migration completes under reject mode (_bypassEvidenceClassification)", async () => {
      // Realistic edge case: a workspace where reject mode was flipped on
      // before first migration ran. Migration tags pre-existing user pages
      // with `legacyUnsupported: true` — without the bypass opt the
      // classifier would throw on those internal writes and migration
      // would never complete.
      const { migrateExistingPagesForEvidence } = await import("./evidence-migration.js");
      const wiki = freshWiki();
      // Seed pre-existing page in warn mode (typical pre-Phase-2b state).
      wiki.write("legacy-page.md", "---\ntitle: P\n---\nNo sources.");
      // Flip to reject mode and run migration — must complete without throw.
      wiki.config.evidence.rejectUnsupportedWrites = true;
      expect(() => migrateExistingPagesForEvidence(wiki, [])).not.toThrow();
      const after = wiki.read("legacy-page.md");
      expect(after?.frontmatter.legacyUnsupported).toBe(true);
    });

    it("loads rejectUnsupportedWrites from env var when set", () => {
      const orig = process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED;
      try {
        process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED = "true";
        const wiki = freshWiki();
        expect(wiki.config.evidence.rejectUnsupportedWrites).toBe(true);
      } finally {
        if (orig === undefined) delete process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED;
        else process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED = orig;
      }
    });

    it("env var = 'false' overrides any YAML / default and forces warn mode", () => {
      const orig = process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED;
      try {
        process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED = "false";
        const wiki = freshWiki();
        expect(wiki.config.evidence.rejectUnsupportedWrites).toBe(false);
      } finally {
        if (orig === undefined) delete process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED;
        else process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED = orig;
      }
    });

    it("env var is case-insensitive — 'TRUE' enables reject mode", () => {
      const orig = process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED;
      try {
        process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED = "TRUE";
        const wiki = freshWiki();
        expect(wiki.config.evidence.rejectUnsupportedWrites).toBe(true);
      } finally {
        if (orig === undefined) delete process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED;
        else process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED = orig;
      }
    });

    it("env var is case-insensitive — 'False' force-disables reject mode", () => {
      const orig = process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED;
      try {
        process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED = "False";
        const wiki = freshWiki();
        expect(wiki.config.evidence.rejectUnsupportedWrites).toBe(false);
      } finally {
        if (orig === undefined) delete process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED;
        else process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED = orig;
      }
    });

    it("loads rejectUnsupportedWrites from .agent-wiki.yaml when env var is unset", () => {
      const orig = process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED;
      delete process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED;
      try {
        // Init creates the default config; overwrite with one that has
        // reject mode enabled, then construct a fresh Wiki to re-parse.
        Wiki.init(TEST_ROOT);
        writeFileSync(
          join(TEST_ROOT, ".agent-wiki.yaml"),
          "version: '2'\n"
            + "wiki:\n  path: wiki/\n  raw_path: raw/\n  schemas_path: schemas/\n"
            + "evidence:\n  reject_unsupported_writes: true\n",
        );
        const wiki = new Wiki(TEST_ROOT);
        expect(wiki.config.evidence.rejectUnsupportedWrites).toBe(true);
      } finally {
        if (orig !== undefined) process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED = orig;
      }
    });

    it("YAML non-boolean values (e.g. 'yes', 1) do NOT enable reject mode", () => {
      const orig = process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED;
      delete process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED;
      try {
        Wiki.init(TEST_ROOT);
        writeFileSync(
          join(TEST_ROOT, ".agent-wiki.yaml"),
          "version: '2'\n"
            + "wiki:\n  path: wiki/\n  raw_path: raw/\n  schemas_path: schemas/\n"
            + "evidence:\n  reject_unsupported_writes: 'yes'\n",
        );
        const wiki = new Wiki(TEST_ROOT);
        expect(wiki.config.evidence.rejectUnsupportedWrites).toBe(false);
      } finally {
        if (orig !== undefined) process.env.AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED = orig;
      }
    });
  });
});

describe("wiki.delete", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("deletes an existing page", () => {
    const wiki = freshWiki();
    wiki.write("to-delete.md", "---\ntitle: Delete Me\n---\nGone");
    const existed = wiki.delete("to-delete.md");
    expect(existed).toBe(true);
    expect(wiki.read("to-delete.md")).toBeNull();
  });

  it("returns false for non-existent page", () => {
    const wiki = freshWiki();
    expect(wiki.delete("nope.md")).toBe(false);
  });

  it("refuses to delete system pages", () => {
    const wiki = freshWiki();
    expect(() => wiki.delete("index.md")).toThrow();
    expect(() => wiki.delete("log.md")).toThrow();
    expect(() => wiki.delete("timeline.md")).toThrow();
  });
});

describe("wiki.list", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("lists all non-system pages", () => {
    const wiki = freshWiki();
    wiki.write("concept-a.md", "---\ntitle: A\ntype: concept\ntags: [x]\n---\nA");
    wiki.write("person-b.md", "---\ntitle: B\ntype: person\ntags: [y]\n---\nB");
    const pages = wiki.list();
    // Should include our pages + system pages
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages).toContain("concept-a.md");
    expect(pages).toContain("person-b.md");
  });

  it("filters by type", () => {
    const wiki = freshWiki();
    wiki.write("concept-x.md", "---\ntitle: X\ntype: concept\n---\nX");
    wiki.write("person-y.md", "---\ntitle: Y\ntype: person\n---\nY");
    const concepts = wiki.list("concept");
    expect(concepts).toContain("concept-x.md");
    expect(concepts).not.toContain("person-y.md");
  });

  it("filters by tag", () => {
    const wiki = freshWiki();
    wiki.write("tagged-a.md", "---\ntitle: A\ntags: [ml, python]\n---\nA");
    wiki.write("tagged-b.md", "---\ntitle: B\ntags: [rust]\n---\nB");
    const mlPages = wiki.list(undefined, "ml");
    expect(mlPages).toContain("tagged-a.md");
    expect(mlPages).not.toContain("tagged-b.md");
  });
});

// ═══════════════════════════════════════════════════════════════════
//  SEARCH
// ═══════════════════════════════════════════════════════════════════

describe("wiki.search", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("finds pages by keyword", () => {
    const wiki = freshWiki();
    wiki.write("concept-yolo.md", "---\ntitle: YOLO Overview\ntype: concept\ntags: [detection]\n---\nYOLO is a real-time object detection model.");
    wiki.write("concept-bert.md", "---\ntitle: BERT Overview\ntype: concept\ntags: [nlp]\n---\nBERT is a language model.");
    const results = wiki.search("YOLO");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.path).toBe("concept-yolo.md");
  });

  it("returns empty for no matches", () => {
    const wiki = freshWiki();
    wiki.write("page.md", "---\ntitle: Page\n---\nSome content");
    expect(wiki.search("nonexistent_xyz_12345")).toEqual([]);
  });

  it("boosts title matches", () => {
    const wiki = freshWiki();
    wiki.write("a.md", "---\ntitle: Python Guide\n---\nLearn Python programming.");
    wiki.write("b.md", "---\ntitle: JavaScript Guide\n---\nPython is mentioned here too.");
    const results = wiki.search("python");
    // Title match should rank higher
    expect(results[0]!.path).toBe("a.md");
  });

  it("respects limit", () => {
    const wiki = freshWiki();
    for (let i = 0; i < 5; i++) {
      wiki.write(`page-${i}.md`, `---\ntitle: Page ${i}\n---\nCommon keyword here.`);
    }
    const results = wiki.search("keyword", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("returns snippets", () => {
    const wiki = freshWiki();
    wiki.write("snippet.md", "---\ntitle: Snippet Test\n---\nThe quick brown fox jumps over the lazy dog.");
    const results = wiki.search("fox");
    expect(results[0]!.snippet).toBeTruthy();
    expect(results[0]!.snippet.toLowerCase()).toContain("fox");
  });

  it("rebuild invalidates search cache so new pages are found", () => {
    const wiki = freshWiki();
    wiki.write("concept-a.md", "---\ntitle: Alpha Concept\ntype: concept\n---\nAlpha.");
    // Warm the search cache
    wiki.search("Alpha");
    // Rebuild writes index.md which should invalidate the cache
    wiki.rebuildIndex();
    // Now search for content in the rebuilt index
    const results = wiki.search("Knowledge Base Index");
    expect(results.some((r) => r.path === "index.md")).toBe(true);
  });

  it("write invalidates search cache", () => {
    const wiki = freshWiki();
    wiki.write("a.md", "---\ntitle: Old\n---\nOld content.");
    // Warm cache
    expect(wiki.search("Old").length).toBeGreaterThan(0);
    // Write new page
    wiki.write("b.md", "---\ntitle: Brand New Page\n---\nBrand new unique content.");
    // Must find the new page without manual invalidation
    const results = wiki.search("Brand New Page");
    expect(results.some((r) => r.path === "b.md")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  LINT
// ═══════════════════════════════════════════════════════════════════

describe("wiki.lint", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("runs without errors on fresh wiki", () => {
    const wiki = freshWiki();
    const report = wiki.lint();
    expect(report.pagesChecked).toBeGreaterThan(0);
    expect(report.contradictions).toEqual([]);
  });

  it("detects broken links", () => {
    const wiki = freshWiki();
    wiki.write("broken.md", "---\ntitle: Broken Links\ntype: note\n---\nSee [[nonexistent-page]].");
    const report = wiki.lint();
    const brokenLink = report.issues.find(
      i => i.category === "broken-link" && i.page === "broken.md"
    );
    expect(brokenLink).toBeDefined();
    expect(brokenLink!.message).toContain("nonexistent-page");
  });

  it("detects orphan pages", () => {
    const wiki = freshWiki();
    wiki.write("orphan.md", "---\ntitle: Lonely Page\ntype: note\n---\nNo one links here.");
    const report = wiki.lint();
    const orphan = report.issues.find(
      i => i.category === "orphan" && i.page === "orphan.md"
    );
    expect(orphan).toBeDefined();
  });

  it("detects missing sources", () => {
    const wiki = freshWiki();
    wiki.write("no-sources.md", "---\ntitle: No Sources\ntype: concept\ntags: [x]\n---\nClaims without evidence.");
    const report = wiki.lint();
    const missing = report.issues.find(
      i => i.category === "missing-source" && i.page === "no-sources.md"
    );
    expect(missing).toBeDefined();
  });

  it("detects corrupted raw files", () => {
    const wiki = freshWiki();
    wiki.rawAdd("integrity.txt", { content: "original" });
    // Corrupt the file
    writeFileSync(join(wiki.config.rawDir, "integrity.txt"), "tampered");
    const report = wiki.lint();
    const corruption = report.issues.find(
      i => i.category === "integrity" && i.message.includes("corrupted")
    );
    expect(corruption).toBeDefined();
  });

  it("detects missing frontmatter", () => {
    const wiki = freshWiki();
    // Write a page with no frontmatter
    writeFileSync(
      join(wiki.config.wikiDir, "bare.md"),
      "Just text, no frontmatter."
    );
    const report = wiki.lint();
    const noFm = report.issues.find(
      i => i.category === "structure" && i.page === "bare.md" && i.message.includes("frontmatter")
    );
    expect(noFm).toBeDefined();
  });

  it("detects contradictions between related pages (shared tag)", () => {
    const wiki = freshWiki();
    // Pages share "yolo" tag → topic isolation allows comparison
    wiki.write("page-a.md", "---\ntitle: YOLO Facts A\ntype: concept\ntags: [yolo]\n---\nYOLO was released in 2015.");
    wiki.write("page-b.md", "---\ntitle: YOLO Facts B\ntype: concept\ntags: [yolo]\n---\nYOLO was released in 2018.");
    const report = wiki.lint();
    expect(report.contradictions.length).toBeGreaterThan(0);
  });

  it("does NOT report contradictions for unrelated pages (no shared tag/link)", () => {
    const wiki = freshWiki();
    // Pages have no shared tags and no links between them
    wiki.write("alpha.md", "---\ntitle: Alpha\ntype: concept\ntags: [alpha]\n---\nAlpha was released in 2015.");
    wiki.write("beta.md", "---\ntitle: Beta\ntype: concept\ntags: [beta]\n---\nBeta was released in 2018.");
    const report = wiki.lint();
    expect(report.contradictions).toHaveLength(0);
  });

  it("detects contradictions between linked pages", () => {
    const wiki = freshWiki();
    // page-b links to page-a → they are related
    wiki.write("fact-a.md", "---\ntitle: Fact A\ntype: concept\ntags: [x]\n---\nFoo was released in 2015.");
    wiki.write("fact-b.md", "---\ntitle: Fact B\ntype: concept\ntags: [y]\n---\nFoo was released in 2020. See [[fact-a]].");
    const report = wiki.lint();
    expect(report.contradictions.length).toBeGreaterThan(0);
  });

  it("does not flag same-value numeric claims as contradictions", () => {
    const wiki = freshWiki();
    wiki.write("p1.md", "---\ntitle: P1\ntype: concept\ntags: [ml]\n---\nAchieves 76% accuracy.");
    wiki.write("p2.md", "---\ntitle: P2\ntype: concept\ntags: [ml]\n---\nAchieves 76% accuracy.");
    const report = wiki.lint();
    // Same value → no contradiction
    const numericContradictions = report.contradictions.filter(c => c.claim.includes("accuracy") || c.claim.includes("%"));
    expect(numericContradictions).toHaveLength(0);
  });

  it("normalizes units — 1000 ms vs 1 s not a contradiction", () => {
    const wiki = freshWiki();
    wiki.write("fast-a.md", "---\ntitle: Fast A\ntype: concept\ntags: [perf]\n---\nLatency is 1000 ms.");
    wiki.write("fast-b.md", "---\ntitle: Fast B\ntype: concept\ntags: [perf]\n---\nLatency is 1 s.");
    const report = wiki.lint();
    const latencyContradictions = report.contradictions.filter(c => c.claim.includes("latenc") || c.claim.includes("s"));
    // 1000 ms = 1 s after normalization → no contradiction
    expect(latencyContradictions).toHaveLength(0);
  });

  it("auto-fixes missing frontmatter when apply_fixes is true", () => {
    const wiki = freshWiki();
    // Write a page with no frontmatter directly
    writeFileSync(
      join(wiki.config.wikiDir, "bare.md"),
      "Neural networks are deep learning models used for classification."
    );
    const report = wiki.lint(true);
    expect(report.fixed).toBe(1);
    expect(report.fixedPages).toContain("bare.md");
    // Page should now have frontmatter
    const fixedPage = wiki.read("bare.md");
    expect(fixedPage).not.toBeNull();
    expect(Object.keys(fixedPage!.frontmatter).length).toBeGreaterThan(0);
    expect(fixedPage!.title).not.toBe(""); // title injected
  });

  it("returns fixed:0 when apply_fixes is false (default)", () => {
    const wiki = freshWiki();
    writeFileSync(join(wiki.config.wikiDir, "bare2.md"), "Some content.");
    const report = wiki.lint(false);
    expect(report.fixed).toBe(0);
    expect(report.fixedPages).toHaveLength(0);
    // Issue still reported
    const issue = report.issues.find(i => i.page === "bare2.md" && i.category === "structure");
    expect(issue).toBeDefined();
  });

  it("broken link suggestion includes did-you-mean from BM25", () => {
    const wiki = freshWiki();
    // Create a real page that should be suggested
    wiki.write("concept-neural-nets.md", "---\ntitle: Neural Nets\ntype: concept\ntags: [ml]\n---\nDeep learning.");
    // Broken link that is close to existing page name
    wiki.write("linker.md", "---\ntitle: Linker\ntype: note\n---\nSee [[concept-neural-network]].");
    const report = wiki.lint();
    const brokenLink = report.issues.find(i => i.category === "broken-link" && i.page === "linker.md");
    expect(brokenLink).toBeDefined();
    // suggestion should mention the similar existing page
    expect(brokenLink!.suggestion).toMatch(/did you mean|concept-neural-nets/i);
  });

  it("checks synthesis page integrity", () => {
    const wiki = freshWiki();
    wiki.write("synthesis-x.md", `---
title: Synthesis X
type: synthesis
derived_from:
  - missing-source-page
---
Combined insights.`);
    const report = wiki.lint();
    const synthIssue = report.issues.find(
      i => i.category === "integrity" && i.page === "synthesis-x.md"
    );
    expect(synthIssue).toBeDefined();
    expect(synthIssue!.message).toContain("missing-source-page");
  });
});

describe("wiki.lint — integrity cache", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("creates .lint-cache.json after lint", () => {
    const wiki = freshWiki();
    wiki.rawAdd("cached.txt", { content: "hello" });
    wiki.lint();
    expect(existsSync(join(wiki.config.workspace, ".lint-cache.json"))).toBe(true);
  });

  it("returns same results on second lint (cache hit)", () => {
    const wiki = freshWiki();
    wiki.rawAdd("stable.txt", { content: "stable content" });
    const report1 = wiki.lint();
    const report2 = wiki.lint();
    expect(report2.rawChecked).toBe(report1.rawChecked);
    expect(report2.issues.filter(i => i.category === "integrity"))
      .toEqual(report1.issues.filter(i => i.category === "integrity"));
  });

  it("detects corruption even with stale cache", () => {
    const wiki = freshWiki();
    wiki.rawAdd("will-corrupt.txt", { content: "original" });
    wiki.lint(); // populates cache with "ok"
    writeFileSync(join(wiki.config.rawDir, "will-corrupt.txt"), "tampered");
    const report = wiki.lint();
    const corruption = report.issues.find(
      i => i.category === "integrity" && i.message.includes("corrupted"),
    );
    expect(corruption).toBeDefined();
  });

  it("re-checks when meta.yaml changes", () => {
    const wiki = freshWiki();
    wiki.rawAdd("meta-change.txt", { content: "content" });
    wiki.lint(); // populates cache
    // Corrupt the expected hash in meta
    const metaPath = join(wiki.config.rawDir, "meta-change.txt.meta.yaml");
    const metaContent = readFileSync(metaPath, "utf-8");
    writeFileSync(metaPath, metaContent.replace(/sha256: [a-f0-9]+/, "sha256: 0000000000000000000000000000000000000000000000000000000000000000"));
    const report = wiki.lint();
    const corruption = report.issues.find(
      i => i.category === "integrity" && i.message.includes("corrupted"),
    );
    expect(corruption).toBeDefined();
  });

  it("handles corrupt cache file gracefully", () => {
    const wiki = freshWiki();
    wiki.rawAdd("robust.txt", { content: "data" });
    writeFileSync(join(wiki.config.workspace, ".lint-cache.json"), "not json!!!");
    const report = wiki.lint();
    expect(report.rawChecked).toBeGreaterThan(0);
  });

  it("ignores cache with wrong version", () => {
    const wiki = freshWiki();
    wiki.rawAdd("versioned.txt", { content: "data" });
    writeFileSync(
      join(wiki.config.workspace, ".lint-cache.json"),
      JSON.stringify({ version: 999, entries: {} }),
    );
    const report = wiki.lint();
    expect(report.rawChecked).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  CLASSIFY
// ═══════════════════════════════════════════════════════════════════

describe("wiki.classify", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("classifies a person page", () => {
    const wiki = freshWiki();
    const result = wiki.classify("---\ntitle: Albert Einstein\n---\nBorn in 1879, researcher, professor of physics.");
    expect(result.type).toBe("person");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("classifies a concept page", () => {
    const wiki = freshWiki();
    const result = wiki.classify("---\ntitle: GIL\n---\nDefinition: The Global Interpreter Lock is a concept in Python.");
    expect(result.type).toBe("concept");
  });

  it("classifies a how-to page", () => {
    const wiki = freshWiki();
    const result = wiki.classify("---\ntitle: How to Install Docker\n---\nStep 1: Install Docker. Step 2: Setup containers.");
    expect(result.type).toBe("how-to");
  });

  it("respects existing type in frontmatter", () => {
    const wiki = freshWiki();
    const result = wiki.classify("---\ntitle: My Artifact\ntype: artifact\n---\nSome body text.");
    expect(result.type).toBe("artifact");
    expect(result.confidence).toBe(1.0);
  });

  it("classifies a COBOL code page", () => {
    const wiki = freshWiki();
    const result = wiki.classify("---\ntitle: CALC-INTEREST\n---\nIDENTIFICATION DIVISION.\nPROGRAM-ID. CALC-INTEREST.\nDATA DIVISION.\nWORKING-STORAGE SECTION.\nPROCEDURE DIVISION.\nEVALUATE WS-CREDIT-GRADE.");
    expect(result.type).toBe("code");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("classifies code page with code blocks", () => {
    const wiki = freshWiki();
    const result = wiki.classify("---\ntitle: Batch Process\n---\n## 源代码\n\n```cobol\nPROCEDURE DIVISION.\nPERFORM VALIDATE-INPUT.\n```\n\n## 调用关系\n\nCalls VALIDATE-INPUT.");
    expect(result.type).toBe("code");
  });

  it("classifies Python code page", () => {
    const wiki = freshWiki();
    const result = wiki.classify("---\ntitle: Data Pipeline\n---\n## 源代码\n\n```python\ndef process_data():\n    import pandas\n    class DataPipeline:\n        pass\n```");
    expect(result.type).toBe("code");
  });

  it("defaults to note for ambiguous content", () => {
    const wiki = freshWiki();
    const result = wiki.classify("---\ntitle: Random Notes\n---\nJust some random text without clear signals.");
    expect(result.type).toBe("note");
  });

  it("suggests tags", () => {
    const wiki = freshWiki();
    const result = wiki.classify("---\ntitle: PyTorch CNN\n---\nA CNN model built with PyTorch and Python for detection.");
    expect(result.tags.length).toBeGreaterThan(0);
    expect(result.tags).toEqual(expect.arrayContaining(["python"]));
  });
});

describe("wiki.autoClassifyContent", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("enriches content missing type and tags", () => {
    const wiki = freshWiki();
    const input = "---\ntitle: Docker Guide\n---\nStep 1: Install Docker. Step 2: run containers.";
    const enriched = wiki.autoClassifyContent(input);
    expect(enriched).toContain("type:");
    expect(enriched).toContain("tags:");
  });

  it("does not overwrite existing type", () => {
    const wiki = freshWiki();
    const input = "---\ntitle: My Page\ntype: artifact\n---\nSome body.";
    const enriched = wiki.autoClassifyContent(input);
    expect(enriched).toContain("type: artifact");
  });
});

// ═══════════════════════════════════════════════════════════════════
//  AUTO-LINK
// ═══════════════════════════════════════════════════════════════════

describe("wiki.autoLink", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("injects [[slug|text]] link for matching title", () => {
    const wiki = freshWiki();
    wiki.write("concept-yolo.md", "---\ntitle: YOLO Object Detection\ntags: [yolo]\n---\nBody.");
    const content = "---\ntitle: Survey\n---\nWe use YOLO Object Detection here.";
    const { content: out, linksAdded } = wiki.autoLink(content, "survey.md");
    expect(out).toContain("[[concept-yolo|YOLO Object Detection]]");
    expect(linksAdded).toBe(1);
  });

  it("returns unchanged content when no titles match", () => {
    const wiki = freshWiki();
    wiki.write("concept-yolo.md", "---\ntitle: YOLO\ntags: [yolo]\n---\nBody.");
    const content = "---\ntitle: Survey\n---\nNo related content here.";
    const { content: out, linksAdded } = wiki.autoLink(content, "survey.md");
    expect(out).toBe(content);
    expect(linksAdded).toBe(0);
  });

  it("skips self-references", () => {
    const wiki = freshWiki();
    wiki.write("concept-yolo.md", "---\ntitle: YOLO Object Detection\ntags: [yolo]\n---\nBody.");
    const content = "---\ntitle: YOLO Object Detection\n---\nThis page covers YOLO Object Detection.";
    const { linksAdded } = wiki.autoLink(content, "concept-yolo.md");
    expect(linksAdded).toBe(0);
  });

  it("links only the first occurrence of each slug", () => {
    const wiki = freshWiki();
    wiki.write("concept-yolo.md", "---\ntitle: YOLO\ntags: [yolo]\n---\nBody.");
    const content = "---\ntitle: Survey\n---\nYOLO is fast. YOLO is popular.";
    const { content: out, linksAdded } = wiki.autoLink(content, "survey.md");
    expect(linksAdded).toBe(1);
    // Only first occurrence linked
    const matches = [...out.matchAll(/\[\[concept-yolo\|/g)];
    expect(matches).toHaveLength(1);
  });

  it("skips mentions inside fenced code blocks", () => {
    const wiki = freshWiki();
    wiki.write("concept-yolo.md", "---\ntitle: YOLO\ntags: [yolo]\n---\nBody.");
    const content = "---\ntitle: Survey\n---\n```\nYOLO is a model\n```";
    const { linksAdded } = wiki.autoLink(content, "survey.md");
    expect(linksAdded).toBe(0);
  });

  it("skips mentions inside inline code", () => {
    const wiki = freshWiki();
    wiki.write("concept-yolo.md", "---\ntitle: YOLO\ntags: [yolo]\n---\nBody.");
    const content = "---\ntitle: Survey\n---\nUse `YOLO` for detection.";
    const { linksAdded } = wiki.autoLink(content, "survey.md");
    expect(linksAdded).toBe(0);
  });

  it("skips mentions inside existing [[wiki links]]", () => {
    const wiki = freshWiki();
    wiki.write("concept-yolo.md", "---\ntitle: YOLO\ntags: [yolo]\n---\nBody.");
    const content = "---\ntitle: Survey\n---\nSee [[concept-yolo]] for details.";
    const { linksAdded } = wiki.autoLink(content, "survey.md");
    expect(linksAdded).toBe(0);
  });

  it("skips mentions inside bare URLs", () => {
    const wiki = freshWiki();
    wiki.write("concept-docker.md", "---\ntitle: Docker\ntags: [docker]\n---\nBody.");
    const content = "---\ntitle: Dev\n---\nSee https://docs.docker.com for Docker setup.";
    const { content: out, linksAdded } = wiki.autoLink(content, "dev.md");
    // "Docker" after the URL should be linked, but the URL itself should not be touched
    expect(out).not.toContain("https://docs.[[");
    // The standalone "Docker" mention should be linked
    expect(linksAdded).toBe(1);
  });

  it("prefers longer title over shorter when both match (longest-first)", () => {
    const wiki = freshWiki();
    wiki.write("concept-yolo.md", "---\ntitle: YOLO\ntags: [yolo]\n---\nBody.");
    wiki.write("concept-yolo-full.md", "---\ntitle: YOLO Object Detection\ntags: [yolo]\n---\nBody.");
    const content = "---\ntitle: Survey\n---\nYOLO Object Detection is key.";
    const { content: out } = wiki.autoLink(content, "survey.md");
    // Longer title wins — should link to the full page, not the short one
    expect(out).toContain("[[concept-yolo-full|YOLO Object Detection]]");
    expect(out).not.toContain("[[concept-yolo|YOLO Object Detection]]");
  });

  it("skips titles shorter than 4 chars", () => {
    const wiki = freshWiki();
    wiki.write("concept-ml.md", "---\ntitle: ML\ntags: [ml]\n---\nBody.");
    const content = "---\ntitle: Survey\n---\nML is important.";
    const { linksAdded } = wiki.autoLink(content, "survey.md");
    expect(linksAdded).toBe(0);
  });

  it("parsePage correctly extracts slug from [[slug|display text]] links", () => {
    const wiki = freshWiki();
    wiki.write("concept-yolo.md", "---\ntitle: YOLO\ntags: [yolo]\n---\nBody.");
    wiki.write("note-survey.md", "---\ntitle: Survey\n---\nWe use [[concept-yolo|YOLO Object Detection]] daily.");
    const page = wiki.read("note-survey.md");
    expect(page!.links).toContain("concept-yolo");
    // Should not contain the display text part
    expect(page!.links.some(l => l.includes("|"))).toBe(false);
  });

  it("cache: second write is visible to subsequent autoLink calls", () => {
    const wiki = freshWiki();
    // First page written before any autoLink call
    wiki.write("concept-alpha.md", "---\ntitle: Alpha System\ntags: [alpha]\n---\nBody.");

    // autoLink primes the cache (O(n) build)
    const { linksAdded: first } = wiki.autoLink(
      "---\ntitle: T\n---\nAlpha System is key.",
      "other.md"
    );
    expect(first).toBe(1);

    // Write a second page — cache should be updated incrementally
    wiki.write("concept-beta.md", "---\ntitle: Beta Framework\ntags: [beta]\n---\nBody.");

    // autoLink should now pick up both pages without a full rebuild
    const { content: out, linksAdded: second } = wiki.autoLink(
      "---\ntitle: T\n---\nAlpha System and Beta Framework work together.",
      "other.md"
    );
    expect(second).toBe(2);
    expect(out).toContain("[[concept-alpha|Alpha System]]");
    expect(out).toContain("[[concept-beta|Beta Framework]]");
  });

  it("config.autoLink.enabled defaults to true and is mutable", () => {
    // The flag is enforced by the server handler (not autoLink() itself).
    // This test verifies the config field is correctly shaped for the handler to read.
    const wiki = freshWiki();
    expect(wiki.config.autoLink.enabled).toBe(true);
    wiki.config.autoLink.enabled = false;
    expect(wiki.config.autoLink.enabled).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  SYNTHESIZE
// ═══════════════════════════════════════════════════════════════════

describe("wiki.synthesizeContext", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("returns content from multiple pages", () => {
    const wiki = freshWiki();
    wiki.write("concept-a.md", "---\ntitle: Concept A\ntags: [ml]\n---\nContent A.");
    wiki.write("concept-b.md", "---\ntitle: Concept B\ntags: [nlp]\n---\nContent B.");
    const ctx = wiki.synthesizeContext(["concept-a.md", "concept-b.md"]);
    expect(ctx.pages).toHaveLength(2);
    expect(ctx.pages[0]!.title).toBe("Concept A");
    expect(ctx.pages[1]!.title).toBe("Concept B");
  });

  it("generates suggestions for multiple pages", () => {
    const wiki = freshWiki();
    wiki.write("p1.md", "---\ntitle: P1\n---\nX");
    wiki.write("p2.md", "---\ntitle: P2\n---\nY");
    const ctx = wiki.synthesizeContext(["p1.md", "p2.md"]);
    expect(ctx.suggestions.length).toBeGreaterThan(0);
  });

  it("skips missing pages gracefully", () => {
    const wiki = freshWiki();
    wiki.write("exists.md", "---\ntitle: Exists\n---\nHere");
    const ctx = wiki.synthesizeContext(["exists.md", "nope.md"]);
    expect(ctx.pages).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  SCHEMAS
// ═══════════════════════════════════════════════════════════════════

describe("wiki.schemas", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("lists all 10 default schemas", () => {
    const wiki = freshWiki();
    const schemas = wiki.schemas();
    expect(schemas.length).toBe(10);
    const names = schemas.map(s => s.name).sort();
    expect(names).toEqual([
      "artifact", "code", "comparison", "concept", "event",
      "how-to", "note", "person", "summary", "synthesis",
    ]);
  });

  it("each schema has name, description, and template", () => {
    const wiki = freshWiki();
    for (const schema of wiki.schemas()) {
      expect(schema.name).toBeTruthy();
      expect(schema.description).toBeTruthy();
      expect(schema.template).toContain("template:");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
//  LOG
// ═══════════════════════════════════════════════════════════════════

describe("wiki.getLog", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("has init entry after fresh init", () => {
    const wiki = freshWiki();
    const log = wiki.getLog();
    expect(log.length).toBeGreaterThan(0);
  });

  it("records write operations", () => {
    const wiki = freshWiki();
    wiki.write("logged.md", "---\ntitle: Logged\n---\nBody");
    const log = wiki.getLog();
    const writeEntry = log.find(e => e.operation === "write" || e.operation === "create");
    expect(writeEntry).toBeDefined();
  });

  it("records raw-add operations", () => {
    const wiki = freshWiki();
    wiki.rawAdd("log-test.txt", { content: "data" });
    const log = wiki.getLog();
    const rawEntry = log.find(e => e.operation === "raw-add");
    expect(rawEntry).toBeDefined();
  });

  it("respects limit", () => {
    const wiki = freshWiki();
    for (let i = 0; i < 10; i++) {
      wiki.write(`bulk-${i}.md`, `---\ntitle: Bulk ${i}\n---\nBody ${i}`);
    }
    const log = wiki.getLog(3);
    expect(log.length).toBeLessThanOrEqual(3);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  INDEX & TIMELINE REBUILD
// ═══════════════════════════════════════════════════════════════════

describe("wiki.rebuildIndex", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("rebuilds index with page counts (flat mode)", () => {
    const wiki = freshWiki();
    wiki.write("concept-a.md", "---\ntitle: A\ntype: concept\n---\nA");
    wiki.write("person-b.md", "---\ntitle: B\ntype: person\n---\nB");
    wiki.rebuildIndex();
    const index = readFileSync(join(wiki.config.wikiDir, "index.md"), "utf-8");
    expect(index).toContain("concept-a");
    expect(index).toContain("person-b");
    expect(index).toContain("2 pages");
  });

  it("generates topic sub-indexes when subdirectories exist", () => {
    const wiki = freshWiki();
    wiki.write("cobol/concept-cobol.md", "---\ntitle: COBOL Basics\ntype: concept\n---\nCOBOL.");
    wiki.write("cobol/how-to-cobol-modernization.md", "---\ntitle: COBOL Modernization\ntype: how-to\n---\nModernize.");
    wiki.write("yolo/concept-yolo-overview.md", "---\ntitle: YOLO Overview\ntype: concept\n---\nYOLO.");
    wiki.rebuildIndex();

    // Top-level index should list topics
    const index = readFileSync(join(wiki.config.wikiDir, "index.md"), "utf-8");
    expect(index).toContain("3 pages");
    expect(index).toContain("2 topics");
    expect(index).toContain("[[cobol/index]]");
    expect(index).toContain("[[yolo/index]]");
    expect(index).toContain("cobol (2 pages)");
    expect(index).toContain("yolo (1 pages)");

    // COBOL sub-index should exist and list its pages
    const cobolIndex = readFileSync(join(wiki.config.wikiDir, "cobol/index.md"), "utf-8");
    expect(cobolIndex).toContain("COBOL Basics");
    expect(cobolIndex).toContain("COBOL Modernization");
    expect(cobolIndex).toContain("[[cobol/concept-cobol]]");
    expect(cobolIndex).toContain("2 pages");

    // YOLO sub-index
    const yoloIndex = readFileSync(join(wiki.config.wikiDir, "yolo/index.md"), "utf-8");
    expect(yoloIndex).toContain("YOLO Overview");
    expect(yoloIndex).toContain("1 pages");
  });

  it("mixes topic dirs with root-level pages", () => {
    const wiki = freshWiki();
    wiki.write("cobol/concept-cobol.md", "---\ntitle: COBOL Basics\ntype: concept\n---\nCOBOL.");
    wiki.write("note-misc.md", "---\ntitle: Misc Note\ntype: note\n---\nMisc.");
    wiki.rebuildIndex();

    const index = readFileSync(join(wiki.config.wikiDir, "index.md"), "utf-8");
    expect(index).toContain("2 pages");
    expect(index).toContain("[[cobol/index]]");
    expect(index).toContain("[[note-misc]]");
  });

  it("generates multi-level nested indexes", () => {
    const wiki = freshWiki();
    wiki.write("lang/js/concept-closures.md", "---\ntitle: JS Closures\ntype: concept\n---\nClosures.");
    wiki.write("lang/js/frameworks/concept-react.md", "---\ntitle: React Overview\ntype: concept\n---\nReact.");
    wiki.write("lang/python/concept-decorators.md", "---\ntitle: Python Decorators\ntype: concept\n---\nDecorators.");
    wiki.rebuildIndex();

    // Top-level index should list "lang" topic
    const index = readFileSync(join(wiki.config.wikiDir, "index.md"), "utf-8");
    expect(index).toContain("3 pages");
    expect(index).toContain("[[lang/index]]");
    expect(index).toContain("lang (3 pages)");

    // lang/index.md should list sub-topics js and python
    const langIndex = readFileSync(join(wiki.config.wikiDir, "lang/index.md"), "utf-8");
    expect(langIndex).toContain("3 pages");
    expect(langIndex).toContain("## Sub-topics");
    expect(langIndex).toContain("[[lang/js/index]]");
    expect(langIndex).toContain("[[lang/python/index]]");

    // lang/js/index.md should list sub-topic frameworks + direct page
    const jsIndex = readFileSync(join(wiki.config.wikiDir, "lang/js/index.md"), "utf-8");
    expect(jsIndex).toContain("2 pages");
    expect(jsIndex).toContain("## Sub-topics");
    expect(jsIndex).toContain("[[lang/js/frameworks/index]]");
    expect(jsIndex).toContain("[[lang/js/concept-closures]]");
    expect(jsIndex).toContain("JS Closures");

    // lang/js/frameworks/index.md should list the React page
    const fwIndex = readFileSync(join(wiki.config.wikiDir, "lang/js/frameworks/index.md"), "utf-8");
    expect(fwIndex).toContain("1 pages");
    expect(fwIndex).toContain("[[lang/js/frameworks/concept-react]]");
    expect(fwIndex).toContain("React Overview");

    // lang/python/index.md should list the decorators page
    const pyIndex = readFileSync(join(wiki.config.wikiDir, "lang/python/index.md"), "utf-8");
    expect(pyIndex).toContain("1 pages");
    expect(pyIndex).toContain("[[lang/python/concept-decorators]]");
  });

  it("treats nested */index.md as system pages", () => {
    const wiki = freshWiki();
    wiki.write("a/b/c/page.md", "---\ntitle: Deep Page\ntype: note\n---\nDeep.");
    wiki.rebuildIndex();

    // All intermediate index files should exist
    expect(existsSync(join(wiki.config.wikiDir, "a/index.md"))).toBe(true);
    expect(existsSync(join(wiki.config.wikiDir, "a/b/index.md"))).toBe(true);
    expect(existsSync(join(wiki.config.wikiDir, "a/b/c/index.md"))).toBe(true);

    // Nested indexes are system pages — cannot be deleted or written to
    expect(() => wiki.delete("a/b/index.md")).toThrow("Cannot delete system page");
    expect(() => wiki.write("a/b/index.md", "---\ntitle: X\n---\nX")).toThrow("Cannot write to reserved path");
  });

  it("overwrites pre-existing user-authored nested index.md on rebuild", () => {
    const wiki = freshWiki();
    // Simulate a repo that already has a hand-written lang/js/index.md
    // (e.g. created before upgrading to the multi-level index feature)
    const jsDir = join(wiki.config.wikiDir, "lang/js");
    mkdirSync(jsDir, { recursive: true });
    writeFileSync(join(jsDir, "index.md"),
      "---\ntitle: My Hand-Written JS Guide\ntype: concept\n---\n\nCurated content that predates the feature.\n");
    writeFileSync(join(jsDir, "concept-closures.md"),
      "---\ntitle: Closures\ntype: concept\n---\nClosures.\n");

    // First rebuild should overwrite the legacy user-authored index
    wiki.rebuildIndex();

    const jsIndex = readFileSync(join(jsDir, "index.md"), "utf-8");
    expect(jsIndex).not.toContain("My Hand-Written JS Guide");
    expect(jsIndex).not.toContain("Curated content");
    expect(jsIndex).toContain("[[lang/js/concept-closures]]");
    expect(jsIndex).toContain("type: index");

    // Subsequent rebuilds keep it consistent
    wiki.rebuildIndex();
    const jsIndex2 = readFileSync(join(jsDir, "index.md"), "utf-8");
    expect(jsIndex2).toContain("[[lang/js/concept-closures]]");
  });

  it("cleans up stale indexes after deleting last page in subtree", () => {
    const wiki = freshWiki();
    wiki.write("lang/js/concept-js.md", "---\ntitle: JS Basics\ntype: concept\n---\nJS.");
    wiki.write("lang/python/concept-py.md", "---\ntitle: Python Basics\ntype: concept\n---\nPython.");
    wiki.rebuildIndex();

    // Both sub-indexes should exist
    expect(existsSync(join(wiki.config.wikiDir, "lang/js/index.md"))).toBe(true);
    expect(existsSync(join(wiki.config.wikiDir, "lang/python/index.md"))).toBe(true);

    // Delete the only page under lang/python/
    wiki.delete("lang/python/concept-py.md");
    wiki.rebuildIndex();

    // lang/python/ index should be gone, lang/js/ should remain
    expect(existsSync(join(wiki.config.wikiDir, "lang/python/index.md"))).toBe(false);
    expect(existsSync(join(wiki.config.wikiDir, "lang/python"))).toBe(false);
    expect(existsSync(join(wiki.config.wikiDir, "lang/js/index.md"))).toBe(true);

    // lang/index.md should still exist and only reference js
    const langIndex = readFileSync(join(wiki.config.wikiDir, "lang/index.md"), "utf-8");
    expect(langIndex).toContain("[[lang/js/index]]");
    expect(langIndex).not.toContain("python");
  });
});

describe("wiki.rebuildTimeline", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("rebuilds timeline with entries", () => {
    const wiki = freshWiki();
    wiki.write("event-x.md", "---\ntitle: Event X\ntype: event\n---\nSomething happened.");
    wiki.rebuildTimeline();
    const timeline = readFileSync(join(wiki.config.wikiDir, "timeline.md"), "utf-8");
    expect(timeline).toContain("Event X");
    expect(timeline).toContain("[event]");
  });

  it("uses full paths in timeline for subdirectory pages", () => {
    const wiki = freshWiki();
    wiki.write("cobol/concept-cobol.md", "---\ntitle: COBOL Basics\ntype: concept\n---\nCOBOL.");
    wiki.rebuildTimeline();
    const timeline = readFileSync(join(wiki.config.wikiDir, "timeline.md"), "utf-8");
    expect(timeline).toContain("[[cobol/concept-cobol]]");
    expect(timeline).toContain("COBOL Basics");
  });

  it("handles unquoted dates parsed as Date objects by js-yaml", () => {
    const wiki = freshWiki();
    // Write frontmatter with unquoted ISO date — js-yaml parses this as a Date object
    const rawContent =
      "---\ntitle: Date Bug\ntype: note\ncreated: 2025-06-15T10:00:00.000Z\n---\nBody.";
    writeFileSync(join(wiki.config.wikiDir, "date-bug.md"), rawContent);
    // rebuildTimeline calls .slice(0,10) on created — should not throw
    expect(() => wiki.rebuildTimeline()).not.toThrow();
    const timeline = readFileSync(join(wiki.config.wikiDir, "timeline.md"), "utf-8");
    expect(timeline).toContain("2025-06-15");
    expect(timeline).toContain("Date Bug");
  });
});

// ═══════════════════════════════════════════════════════════════════
//  AUTO-ROUTE (resolvePagePath)
// ═══════════════════════════════════════════════════════════════════

describe("wiki.resolvePagePath", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("keeps path as-is if already in a subdirectory", () => {
    const wiki = freshWiki();
    wiki.write("cobol/concept-cobol.md", "---\ntitle: COBOL\ntype: concept\n---\nCOBOL.");
    const resolved = wiki.resolvePagePath("cobol/new-page.md", "---\ntitle: New\n---\nContent");
    expect(resolved).toBe("cobol/new-page.md");
  });

  it("routes via explicit topic frontmatter field", () => {
    const wiki = freshWiki();
    wiki.write("cobol/concept-cobol.md", "---\ntitle: COBOL\ntype: concept\n---\nCOBOL.");
    const resolved = wiki.resolvePagePath("new-page.md", "---\ntitle: New\ntopic: cobol\n---\nContent");
    expect(resolved).toBe("cobol/new-page.md");
  });

  it("routes via tag matching against existing topic dirs", () => {
    const wiki = freshWiki();
    wiki.write("yolo/concept-yolo.md", "---\ntitle: YOLO\ntype: concept\n---\nYOLO.");
    // Content about YOLO should be routed to the yolo/ directory
    const resolved = wiki.resolvePagePath("yolo-v8.md", "---\ntitle: YOLOv8 Architecture\ntype: concept\n---\nYOLO v8 object detection model.");
    expect(resolved).toBe("yolo/yolo-v8.md");
  });

  it("keeps at root when no matching topic dir exists", () => {
    const wiki = freshWiki();
    wiki.write("cobol/concept-cobol.md", "---\ntitle: COBOL\ntype: concept\n---\nCOBOL.");
    const resolved = wiki.resolvePagePath("rust-basics.md", "---\ntitle: Rust Basics\ntype: concept\n---\nRust programming.");
    expect(resolved).toBe("rust-basics.md");
  });

  it("returns original path when no topic dirs exist", () => {
    const wiki = freshWiki();
    wiki.write("concept-a.md", "---\ntitle: A\ntype: concept\n---\nA.");
    const resolved = wiki.resolvePagePath("new-page.md", "---\ntitle: New\n---\nContent");
    expect(resolved).toBe("new-page.md");
  });

  it("routes to nested directory via tag/title matching (deepest wins)", () => {
    const wiki = freshWiki();
    wiki.write("lang/js/concept-js.md", "---\ntitle: JS\ntype: concept\n---\nJS.");
    wiki.write("lang/python/concept-py.md", "---\ntitle: Python\ntype: concept\n---\nPython.");
    // A page about JS should route to lang/js/, not lang/
    const resolved = wiki.resolvePagePath("js-closures.md", "---\ntitle: JS Closures\ntype: concept\n---\nJavaScript closures.");
    expect(resolved).toBe("lang/js/js-closures.md");
  });

  it("routes to nested directory via explicit topic matching last segment", () => {
    const wiki = freshWiki();
    wiki.write("lang/js/concept-js.md", "---\ntitle: JS\ntype: concept\n---\nJS.");
    // topic: "js" should match lang/js/ not create a new js/ at root
    const resolved = wiki.resolvePagePath("new-page.md", "---\ntitle: New\ntopic: js\n---\nContent");
    expect(resolved).toBe("lang/js/new-page.md");
  });

  it("routes via explicit topic with full nested path", () => {
    const wiki = freshWiki();
    wiki.write("lang/js/concept-js.md", "---\ntitle: JS\ntype: concept\n---\nJS.");
    const resolved = wiki.resolvePagePath("new-page.md", "---\ntitle: New\ntopic: lang/js\n---\nContent");
    expect(resolved).toBe("lang/js/new-page.md");
  });
});

describe("wiki.listTopicDirs", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("lists existing topic subdirectories", () => {
    const wiki = freshWiki();
    wiki.write("cobol/a.md", "---\ntitle: A\n---\nA");
    wiki.write("yolo/b.md", "---\ntitle: B\n---\nB");
    const dirs = wiki.listTopicDirs();
    expect(dirs).toContain("cobol");
    expect(dirs).toContain("yolo");
  });

  it("returns empty when no subdirectories", () => {
    const wiki = freshWiki();
    wiki.write("concept-a.md", "---\ntitle: A\n---\nA");
    const dirs = wiki.listTopicDirs();
    expect(dirs).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  EDGE CASES & ROBUSTNESS
// ═══════════════════════════════════════════════════════════════════

describe("edge cases", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("handles unicode content correctly", () => {
    const wiki = freshWiki();
    const content = "---\ntitle: 中文测试\ntags: [中文]\n---\n这是一个中文页面。";
    wiki.write("chinese.md", content);
    const page = wiki.read("chinese.md");
    expect(page!.title).toBe("中文测试");
    expect(page!.content).toContain("中文页面");
  });

  it("handles empty search query", () => {
    const wiki = freshWiki();
    expect(wiki.search("")).toEqual([]);
    expect(wiki.search("   ")).toEqual([]);
  });

  it("handles pages with no body", () => {
    const wiki = freshWiki();
    wiki.write("empty-body.md", "---\ntitle: Empty\ntype: note\n---\n");
    const page = wiki.read("empty-body.md");
    expect(page).not.toBeNull();
    expect(page!.title).toBe("Empty");
  });

  it("handles raw file with subdirectory", () => {
    const wiki = freshWiki();
    const doc = rawAddOne(wiki, "papers/test.txt", { content: "nested" });
    expect(doc.path).toBe("papers/test.txt");
    const result = wiki.rawList();
    expect(result.find(d => d.path === "papers/test.txt")).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
//  PATH SAFETY — Directory Traversal Prevention
// ═══════════════════════════════════════════════════════════════════

describe("safePath", () => {
  it("allows simple filenames", () => {
    const result = safePath("/base/dir", "file.txt");
    expect(result).toBe("/base/dir/file.txt");
  });

  it("allows subdirectories", () => {
    const result = safePath("/base/dir", "sub/file.txt");
    expect(result).toBe("/base/dir/sub/file.txt");
  });

  it("rejects parent traversal (../)", () => {
    expect(() => safePath("/base/dir", "../etc/passwd")).toThrow(/traversal/i);
  });

  it("rejects deep traversal (../../)", () => {
    expect(() => safePath("/base/dir", "../../etc/shadow")).toThrow(/traversal/i);
  });

  it("rejects traversal disguised in subpath", () => {
    expect(() => safePath("/base/dir", "sub/../../etc/passwd")).toThrow(/traversal/i);
  });

  it("rejects absolute paths", () => {
    expect(() => safePath("/base/dir", "/etc/passwd")).toThrow(/absolute/i);
  });

  it("rejects null bytes", () => {
    expect(() => safePath("/base/dir", "file\0.txt")).toThrow(/null/i);
  });

  it("rejects empty path", () => {
    expect(() => safePath("/base/dir", "")).toThrow();
  });
});

describe("path traversal via wiki methods", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("rawAdd rejects traversal", () => {
    const wiki = freshWiki();
    expect(() => wiki.rawAdd("../escape.txt", { content: "evil" })).toThrow(/traversal/i);
  });

  it("rawRead rejects traversal", async () => {
    const wiki = freshWiki();
    await expect(wiki.rawRead("../../etc/passwd")).rejects.toThrow(/traversal/i);
  });

  it("wiki.read rejects traversal", () => {
    const wiki = freshWiki();
    expect(() => wiki.read("../../../etc/passwd")).toThrow(/traversal/i);
  });

  it("wiki.write rejects traversal", () => {
    const wiki = freshWiki();
    expect(() => wiki.write("../../.bashrc", "---\ntitle: Evil\n---\nHacked")).toThrow(/traversal/i);
  });

  it("wiki.delete rejects traversal", () => {
    const wiki = freshWiki();
    expect(() => wiki.delete("../important.conf")).toThrow(/traversal/i);
  });

  it("allows legitimate subdirectory paths", () => {
    const wiki = freshWiki();
    // These should NOT throw
    wiki.rawAdd("papers/deep/file.txt", { content: "nested ok" });
    wiki.write("topics/concept-a.md", "---\ntitle: Nested\n---\nOk");
    expect(wiki.read("topics/concept-a.md")).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
//  sourcePath restriction (security boundary for file copy)
// ═══════════════════════════════════════════════════════════════════

describe("sourcePath allowed directory restriction", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("allows sourcePath inside workspace (default)", () => {
    const wiki = freshWiki();
    const srcFile = join(TEST_ROOT, "local.txt");
    writeFileSync(srcFile, "ok");
    const doc = rawAddOne(wiki, "imported.txt", { sourcePath: srcFile });
    expect(doc.size).toBeGreaterThan(0);
  });

  it("rejects sourcePath outside workspace", () => {
    const wiki = freshWiki();
    // /tmp is outside the test workspace
    const outsideFile = join("/tmp", `agent-wiki-test-${Date.now()}.txt`);
    writeFileSync(outsideFile, "secret");
    try {
      expect(() => wiki.rawAdd("stolen.txt", { sourcePath: outsideFile }))
        .toThrow(/outside allowed directories/i);
    } finally {
      rmSync(outsideFile, { force: true });
    }
  });

  it("rejects sourcePath with traversal to escape workspace", () => {
    const wiki = freshWiki();
    // Even if file exists, ../../../etc/passwd must be blocked
    expect(() => wiki.rawAdd("etc.txt", { sourcePath: join(TEST_ROOT, "../../../etc/passwd") }))
      .toThrow(/outside allowed directories/i);
  });

  it("respects custom allowedSourceDirs from config", () => {
    const wiki = freshWiki();
    const externalDir = join(TEST_ROOT, "..", "__allowed_external__");
    mkdirSync(externalDir, { recursive: true });
    const extFile = join(externalDir, "ext.txt");
    writeFileSync(extFile, "external ok");

    // Manually widen the config
    wiki.config.allowedSourceDirs.push(externalDir);

    try {
      const doc = rawAddOne(wiki, "from-ext.txt", { sourcePath: extFile });
      expect(doc.size).toBeGreaterThan(0);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("config defaults to workspace only", () => {
    const wiki = freshWiki();
    expect(wiki.config.allowedSourceDirs).toEqual([wiki.config.workspace]);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  ATLASSIAN — Confluence & Jira (unit tests, no live API)
// ═══════════════════════════════════════════════════════════════════

import {
  parseConfluenceUrl,
  parseJiraUrl,
  slugify,
  resolveAuth,
  validateHost,
} from "./atlassian.js";

describe("Confluence URL parsing", () => {
  it("parses Cloud URL with /wiki/ segment and tags it as cloud", () => {
    const result = parseConfluenceUrl(
      "https://acme.atlassian.net/wiki/spaces/ENG/pages/12345/Architecture-Overview"
    );
    expect(result.host).toBe("acme.atlassian.net");
    expect(result.pageId).toBe("12345");
    expect(result.deployment).toBe("cloud");
  });

  it("parses Server / Data Center URL without /wiki/ and tags it as server", () => {
    const result = parseConfluenceUrl(
      "https://confluence.example.com/spaces/ENG/pages/12345/Architecture-Overview"
    );
    expect(result.host).toBe("confluence.example.com");
    expect(result.pageId).toBe("12345");
    expect(result.deployment).toBe("server");
  });

  it("rejects invalid URL with both shapes mentioned in the error", () => {
    expect(() => parseConfluenceUrl("https://example.com/not-confluence")).toThrow(/Cannot parse/);
    expect(() => parseConfluenceUrl("https://example.com/not-confluence")).toThrow(/Cloud[\s\S]+Server/);
  });
});

describe("Jira URL parsing", () => {
  it("parses Cloud URL on *.atlassian.net and tags it as cloud", () => {
    const result = parseJiraUrl("https://acme.atlassian.net/browse/PROJ-123");
    expect(result.host).toBe("acme.atlassian.net");
    expect(result.issueKey).toBe("PROJ-123");
    expect(result.deployment).toBe("cloud");
  });

  it("parses Server / Data Center URL on a self-hosted domain and tags it as server", () => {
    const result = parseJiraUrl("https://jira.example.com/browse/PROJ-456");
    expect(result.host).toBe("jira.example.com");
    expect(result.issueKey).toBe("PROJ-456");
    expect(result.deployment).toBe("server");
  });

  it("rejects invalid URL", () => {
    expect(() => parseJiraUrl("https://example.com/not-jira")).toThrow(/Cannot parse/);
  });
});

describe("slugify", () => {
  it("converts title to safe filename", () => {
    expect(slugify("Architecture Overview")).toBe("architecture-overview");
  });

  it("handles special characters", () => {
    expect(slugify("API Design (v2) — Draft")).toBe("api-design-v2-draft");
  });

  it("truncates long titles", () => {
    const long = "a".repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });
});

describe("resolveAuth", () => {
  it("throws when env var is not set", () => {
    expect(() => resolveAuth("NONEXISTENT_VAR_12345")).toThrow(/not set/);
  });

  it("auto-encodes email:token as Basic auth", () => {
    process.env.__TEST_AUTH__ = "user@example.com:token123";
    try {
      const auth = resolveAuth("__TEST_AUTH__");
      expect(auth).toMatch(/^Basic /);
      const decoded = Buffer.from(auth.replace("Basic ", ""), "base64").toString();
      expect(decoded).toBe("user@example.com:token123");
    } finally {
      delete process.env.__TEST_AUTH__;
    }
  });

  it("passes through Bearer token as-is", () => {
    process.env.__TEST_AUTH__ = "Bearer abc123";
    try {
      expect(resolveAuth("__TEST_AUTH__")).toBe("Bearer abc123");
    } finally {
      delete process.env.__TEST_AUTH__;
    }
  });

  it("auto-prefixes Bearer for a bare PAT (no colon, no prefix)", () => {
    process.env.__TEST_AUTH__ = "abc123-personal-access-token";
    try {
      expect(resolveAuth("__TEST_AUTH__")).toBe("Bearer abc123-personal-access-token");
    } finally {
      delete process.env.__TEST_AUTH__;
    }
  });

  it("error message lists all three accepted forms", () => {
    expect(() => resolveAuth("DEFINITELY_NOT_SET_VAR")).toThrow(/email:api-token/);
    expect(() => resolveAuth("DEFINITELY_NOT_SET_VAR")).toThrow(/Bearer/);
    expect(() => resolveAuth("DEFINITELY_NOT_SET_VAR")).toThrow(/Server.*Data Center/);
  });

  it("error message points to authEnv as the customization escape hatch", () => {
    expect(() => resolveAuth("DEFINITELY_NOT_SET_VAR")).toThrow(/authEnv/);
  });
});

describe("validateHost", () => {
  it("allows any host when allowlist is empty", () => {
    expect(() => validateHost("evil.com", [])).not.toThrow();
  });

  it("allows host in allowlist", () => {
    expect(() => validateHost("acme.atlassian.net", ["acme.atlassian.net"])).not.toThrow();
  });

  it("rejects host not in allowlist", () => {
    expect(() => validateHost("evil.com", ["acme.atlassian.net"])).toThrow(/not in the allowed/);
  });
});

describe("atlassian config in WikiConfig", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it("has default atlassian config", () => {
    const wiki = freshWiki();
    expect(wiki.config.atlassian).toBeDefined();
    expect(wiki.config.atlassian.maxPages).toBe(100);
    expect(wiki.config.atlassian.maxAttachmentSize).toBe(10 * 1024 * 1024);
    expect(wiki.config.atlassian.allowedHosts).toEqual([]);
  });
});
