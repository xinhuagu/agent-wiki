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
import type { WikiPage, LintReport } from "./wiki.js";

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
    const doc = wiki.rawAdd("test.md", { content: "Hello world" });
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
    const doc = wiki.rawAdd("hash-test.txt", { content });
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
    const doc = wiki.rawAdd("copied.txt", { sourcePath: srcFile });
    expect(doc.size).toBeGreaterThan(0);
    const stored = readFileSync(join(wiki.config.rawDir, "copied.txt"), "utf-8");
    expect(stored).toBe("copied content");
  });

  it("stores optional metadata (sourceUrl, description, tags)", () => {
    const wiki = freshWiki();
    const doc = wiki.rawAdd("meta.txt", {
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
    const doc2 = wiki.rawAdd("report.xlsx", { content: "v2 data", autoVersion: true });
    expect(doc2.path).toBe("report_v2.xlsx");
  });

  it("increments to v3 when v2 exists", () => {
    const wiki = freshWiki();
    wiki.rawAdd("report.xlsx", { content: "v1" });
    wiki.rawAdd("report.xlsx", { content: "v2", autoVersion: true });
    const doc3 = wiki.rawAdd("report.xlsx", { content: "v3", autoVersion: true });
    expect(doc3.path).toBe("report_v3.xlsx");
  });

  it("creates v1 normally when file does not exist", () => {
    const wiki = freshWiki();
    const doc = wiki.rawAdd("new-file.xlsx", { content: "first", autoVersion: true });
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

  it("returns binary=true for image files", async () => {
    const wiki = freshWiki();
    // Write a fake PNG (just bytes, not a real image)
    const rawPath = join(wiki.config.rawDir, "photo.png");
    writeFileSync(rawPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(rawPath + ".meta.yaml", `path: photo.png\ndownloadedAt: "2024-01-01"\nsha256: abcd\nsize: 4\nmimeType: image/png\n`);
    const result = await wiki.rawRead("photo.png");
    expect(result!.binary).toBe(true);
    expect(result!.content).toBeNull();
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

  it("detects contradictions between pages", () => {
    const wiki = freshWiki();
    wiki.write("page-a.md", "---\ntitle: YOLO Facts A\ntype: concept\n---\nYOLO was released in 2015.");
    wiki.write("page-b.md", "---\ntitle: YOLO Facts B\ntype: concept\n---\nYOLO was released in 2018.");
    const report = wiki.lint();
    // Should detect the date contradiction
    expect(report.contradictions.length).toBeGreaterThan(0);
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

  it("lists all 9 default schemas", () => {
    const wiki = freshWiki();
    const schemas = wiki.schemas();
    expect(schemas.length).toBe(9);
    const names = schemas.map(s => s.name).sort();
    expect(names).toEqual([
      "artifact", "comparison", "concept", "event",
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

  it("rebuilds index with page counts", () => {
    const wiki = freshWiki();
    wiki.write("concept-a.md", "---\ntitle: A\ntype: concept\n---\nA");
    wiki.write("person-b.md", "---\ntitle: B\ntype: person\n---\nB");
    wiki.rebuildIndex();
    const index = readFileSync(join(wiki.config.wikiDir, "index.md"), "utf-8");
    expect(index).toContain("concept-a");
    expect(index).toContain("person-b");
    expect(index).toContain("2 pages");
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
    const doc = wiki.rawAdd("papers/test.txt", { content: "nested" });
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
    const doc = wiki.rawAdd("imported.txt", { sourcePath: srcFile });
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
      const doc = wiki.rawAdd("from-ext.txt", { sourcePath: extFile });
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
  it("parses standard Confluence page URL", () => {
    const result = parseConfluenceUrl(
      "https://acme.atlassian.net/wiki/spaces/ENG/pages/12345/Architecture-Overview"
    );
    expect(result.host).toBe("acme.atlassian.net");
    expect(result.pageId).toBe("12345");
  });

  it("rejects invalid URL", () => {
    expect(() => parseConfluenceUrl("https://example.com/not-confluence")).toThrow(/Cannot parse/);
  });
});

describe("Jira URL parsing", () => {
  it("parses standard Jira issue URL", () => {
    const result = parseJiraUrl("https://acme.atlassian.net/browse/PROJ-123");
    expect(result.host).toBe("acme.atlassian.net");
    expect(result.issueKey).toBe("PROJ-123");
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
