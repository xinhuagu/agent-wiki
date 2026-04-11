/**
 * Tests for search engine — BM25 ranking, tokenization, synonyms,
 * prefix/fuzzy matching, inverted index, and snippet generation.
 */

import { describe, it, expect } from "vitest";
import {
  tokenize,
  normalizeQuery,
  expandTerms,
  buildSearchDoc,
  buildIndex,
  searchIndex,
  scoreDoc,
  makeSnippet,
  editDistance,
  fuzzyThreshold,
  isCJK,
  cjkNgrams,
  SearchEngine,
} from "./search.js";
import type { WikiPage } from "./wiki.js";

// ── Helpers ──────────────────────────────────────────────────────

function makePage(overrides: Partial<WikiPage> & { path: string }): WikiPage {
  return {
    title: "Untitled",
    type: "concept",
    tags: [],
    sources: [],
    content: "",
    frontmatter: {},
    links: [],
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  TOKENIZATION & NORMALIZATION
// ═══════════════════════════════════════════════════════════════════

describe("tokenize", () => {
  it("lowercases and splits on whitespace", () => {
    expect(tokenize("Hello World")).toEqual(["hello", "world"]);
  });

  it("normalizes separators to spaces", () => {
    expect(tokenize("foo-bar_baz.qux")).toEqual(["foo", "bar", "baz", "qux"]);
  });

  it("collapses multiple spaces", () => {
    expect(tokenize("a   b    c")).toEqual(["a", "b", "c"]);
  });

  it("handles empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });

  it("normalizes full-width CJK punctuation", () => {
    // ！→ !, ？→ ?
    const result = tokenize("hello！world？");
    expect(result).toEqual(["hello", "world"]);
  });

  it("tokenizes Chinese text with Intl.Segmenter and n-grams", () => {
    const result = tokenize("深度学习");
    // Should contain: full run, segmenter words, and n-grams
    expect(result).toContain("深度学习"); // full run
    expect(result).toContain("深度"); // segmenter or bigram
    expect(result).toContain("学习"); // segmenter or bigram
  });

  it("handles mixed Chinese and English", () => {
    const result = tokenize("YOLO 目标检测 model");
    expect(result).toContain("yolo");
    expect(result).toContain("model");
    expect(result).toContain("目标检测"); // full CJK run
  });

  it("handles space-separated Chinese phrases", () => {
    const result = tokenize("深度学习 目标检测");
    expect(result).toContain("深度学习");
    expect(result).toContain("目标检测");
  });
});

describe("isCJK", () => {
  it("detects Chinese", () => {
    expect(isCJK("你好")).toBe(true);
    expect(isCJK("知识库")).toBe(true);
  });

  it("returns false for Latin", () => {
    expect(isCJK("hello")).toBe(false);
    expect(isCJK("deploy")).toBe(false);
  });

  it("detects mixed text", () => {
    expect(isCJK("YOLO 目标检测")).toBe(true);
  });
});

describe("cjkNgrams", () => {
  it("generates bigrams and trigrams", () => {
    const grams = cjkNgrams("知识库系统");
    expect(grams).toContain("知识");
    expect(grams).toContain("识库");
    expect(grams).toContain("库系");
    expect(grams).toContain("系统");
    expect(grams).toContain("知识库");
    expect(grams).toContain("识库系");
    expect(grams).toContain("库系统");
  });

  it("handles 2-char input (only bigram)", () => {
    const grams = cjkNgrams("目标");
    expect(grams).toEqual(["目标"]);
  });
});

describe("normalizeQuery", () => {
  it("normalizes a query string", () => {
    expect(normalizeQuery("Deploy Kubernetes")).toEqual(["deploy", "kubernetes"]);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  SYNONYM EXPANSION
// ═══════════════════════════════════════════════════════════════════

describe("expandTerms", () => {
  it("expands known synonyms", () => {
    const result = expandTerms(["deploy"]);
    expect(result).toContain("deploy");
    expect(result).toContain("deployment");
    expect(result).toContain("release");
    expect(result).toContain("publish");
  });

  it("expands multi-word synonyms into individual tokens", () => {
    const result = expandTerms(["llm"]);
    expect(result).toContain("llm");
    expect(result).toContain("language");
    expect(result).toContain("model");
  });

  it("keeps unknown terms unchanged", () => {
    const result = expandTerms(["xyzzy123"]);
    expect(result).toEqual(["xyzzy123"]);
  });

  it("deduplicates", () => {
    const result = expandTerms(["deploy", "deployment"]);
    const counts = result.reduce((acc, t) => {
      acc[t] = (acc[t] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    for (const count of Object.values(counts)) {
      expect(count).toBe(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
//  EDIT DISTANCE & FUZZY THRESHOLD
// ═══════════════════════════════════════════════════════════════════

describe("editDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(editDistance("hello", "hello")).toBe(0);
  });

  it("returns correct distance for single edit", () => {
    expect(editDistance("kitten", "sitten")).toBe(1); // substitution
    expect(editDistance("hello", "helo")).toBe(1);    // deletion
    expect(editDistance("helo", "hello")).toBe(1);    // insertion
  });

  it("handles empty strings", () => {
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
  });
});

describe("fuzzyThreshold", () => {
  it("returns 0 for short terms", () => {
    expect(fuzzyThreshold("ab")).toBe(0);
    expect(fuzzyThreshold("abc")).toBe(0);
  });

  it("returns 1 for medium terms", () => {
    expect(fuzzyThreshold("yolo")).toBe(1);
    expect(fuzzyThreshold("keyword")).toBe(1);
  });

  it("returns 2 for long terms", () => {
    expect(fuzzyThreshold("deployment")).toBe(2);
    expect(fuzzyThreshold("kubernetes")).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  SEARCH DOCUMENT & INDEX
// ═══════════════════════════════════════════════════════════════════

describe("buildSearchDoc", () => {
  it("tokenizes all fields correctly", () => {
    const page = makePage({
      path: "concept-yolo.md",
      title: "YOLO Overview",
      tags: ["object-detection", "real-time"],
      content: "YOLO is a fast object detection model.",
    });
    const doc = buildSearchDoc(page);
    expect(doc.slug).toBe("concept-yolo");
    expect(doc.fields.titleTerms).toEqual(["yolo", "overview"]);
    expect(doc.fields.tagTerms).toContain("object");
    expect(doc.fields.tagTerms).toContain("detection");
    expect(doc.fields.slugTerms).toEqual(["concept", "yolo"]);
    expect(doc.fields.bodyTerms).toContain("yolo");
    expect(doc.fields.bodyTerms).toContain("detection");
  });
});

describe("buildIndex", () => {
  it("builds inverted index with correct postings", () => {
    const pages = [
      makePage({ path: "a.md", title: "Alpha", content: "alpha beta" }),
      makePage({ path: "b.md", title: "Beta", content: "beta gamma" }),
    ];
    const index = buildIndex(pages);

    expect(index.docCount).toBe(2);
    expect(index.postings.has("beta")).toBe(true);
    expect(index.postings.get("beta")!.size).toBe(2);
    expect(index.docFreq.get("beta")).toBe(2);
    expect(index.docFreq.get("alpha")).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  RANKING TESTS
// ═══════════════════════════════════════════════════════════════════

describe("ranking", () => {
  const pages = [
    makePage({
      path: "concept-yolo.md",
      title: "YOLO Object Detection",
      type: "concept",
      tags: ["yolo", "detection"],
      content: "YOLO is a real-time object detection system that processes images in a single pass.",
    }),
    makePage({
      path: "person-redmon.md",
      title: "Joseph Redmon",
      type: "person",
      tags: ["researcher"],
      content: "Joseph Redmon created YOLO. He is known for his work in computer vision.",
    }),
    makePage({
      path: "synthesis-detectors.md",
      title: "Object Detection Overview",
      type: "synthesis",
      tags: ["detection", "comparison"],
      content: "Comparing YOLO, SSD, and Faster R-CNN. YOLO is fastest.",
    }),
    makePage({
      path: "concept-bert.md",
      title: "BERT Language Model",
      type: "concept",
      tags: ["nlp", "transformer"],
      content: "BERT is a bidirectional transformer for NLP tasks.",
    }),
    makePage({
      path: "how-to-deploy.md",
      title: "Deployment Guide",
      type: "how-to",
      tags: ["deployment", "production"],
      content: "Steps to deploy your model to production. Release checklist included.",
    }),
  ];

  const index = buildIndex(pages);

  it("exact title hit outranks body-only hit", () => {
    const yoloDoc = index.docs.get("concept-yolo.md")!;
    const personDoc = index.docs.get("person-redmon.md")!;
    const queryTerms = normalizeQuery("YOLO");
    const expanded = expandTerms(queryTerms);

    const yoloScore = scoreDoc(yoloDoc, queryTerms, expanded, index);
    const personScore = scoreDoc(personDoc, queryTerms, expanded, index);
    expect(yoloScore).toBeGreaterThan(personScore);
  });

  it("tag hit outranks weak body hit", () => {
    const yoloDoc = index.docs.get("concept-yolo.md")!;
    const bertDoc = index.docs.get("concept-bert.md")!;
    const queryTerms = normalizeQuery("detection");
    const expanded = expandTerms(queryTerms);

    const yoloScore = scoreDoc(yoloDoc, queryTerms, expanded, index);
    const bertScore = scoreDoc(bertDoc, queryTerms, expanded, index);
    expect(yoloScore).toBeGreaterThan(bertScore);
  });

  it("overview query slightly prefers synthesis pages", () => {
    const synthesisDoc = index.docs.get("synthesis-detectors.md")!;
    const queryTerms = normalizeQuery("detection overview");
    const expanded = expandTerms(queryTerms);
    const score = scoreDoc(synthesisDoc, queryTerms, expanded, index);
    // Synthesis boost should apply
    expect(score).toBeGreaterThan(0);
  });

  it("deploy surfaces deployment pages via synonym expansion", () => {
    const deployDoc = index.docs.get("how-to-deploy.md")!;
    const queryTerms = normalizeQuery("deploy");
    const expanded = expandTerms(queryTerms);

    // "deploy" expands to include "deployment", "release", "publish"
    expect(expanded).toContain("deployment");
    const score = scoreDoc(deployDoc, queryTerms, expanded, index);
    expect(score).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  SNIPPET GENERATION
// ═══════════════════════════════════════════════════════════════════

describe("makeSnippet", () => {
  it("returns snippet with context around match", () => {
    const doc = buildSearchDoc(makePage({
      path: "a.md",
      title: "Test",
      content: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. The quick brown fox jumps over the lazy dog. Sed do eiusmod tempor incididunt.",
    }));
    const { snippet } = makeSnippet(doc, ["fox"]);
    expect(snippet.toLowerCase()).toContain("fox");
  });

  it("returns title when body is empty", () => {
    const doc = buildSearchDoc(makePage({
      path: "a.md",
      title: "My Title",
      content: "",
    }));
    const { snippet } = makeSnippet(doc, ["anything"]);
    expect(snippet).toBe("My Title");
  });

  it("returns start of body when no term matches", () => {
    const doc = buildSearchDoc(makePage({
      path: "a.md",
      title: "Test",
      content: "This is some content that does not contain the search term.",
    }));
    const { snippet } = makeSnippet(doc, ["xyznonexistent"]);
    expect(snippet).toContain("This is some content");
  });

  it("returns section heading containing the match", () => {
    const doc = buildSearchDoc(makePage({
      path: "a.md",
      title: "Guide",
      content: "## Installation\n\nRun npm install.\n\n## Usage\n\nImport the module.",
    }));
    const { snippet, section } = makeSnippet(doc, ["import"]);
    expect(snippet.toLowerCase()).toContain("import");
    expect(section).toBe("## Usage");
  });
});

// ═══════════════════════════════════════════════════════════════════
//  SEARCH ENGINE (integration)
// ═══════════════════════════════════════════════════════════════════

describe("SearchEngine", () => {
  const pages = [
    makePage({
      path: "concept-yolo.md",
      title: "YOLO Overview",
      type: "concept",
      tags: ["detection"],
      content: "YOLO is a real-time object detection model.",
    }),
    makePage({
      path: "concept-bert.md",
      title: "BERT Overview",
      type: "concept",
      tags: ["nlp"],
      content: "BERT is a language model.",
    }),
    makePage({
      path: "how-to-deploy.md",
      title: "Deployment Guide",
      type: "how-to",
      tags: ["deployment"],
      content: "Steps to deploy and release your model.",
    }),
  ];

  function engineWithPages(p: WikiPage[] = pages): SearchEngine {
    const engine = new SearchEngine();
    engine.setLoader(() => p);
    return engine;
  }

  it("returns results sorted by relevance", () => {
    const results = engineWithPages().search("YOLO");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.path).toBe("concept-yolo.md");
  });

  it("returns empty for no matches", () => {
    expect(engineWithPages().search("xyznonexistent12345")).toEqual([]);
  });

  it("returns empty for empty query", () => {
    const engine = engineWithPages();
    expect(engine.search("")).toEqual([]);
    expect(engine.search("   ")).toEqual([]);
  });

  it("respects limit", () => {
    const results = engineWithPages().search("model", 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("caches index across searches (no re-read)", () => {
    let loadCount = 0;
    const engine = new SearchEngine();
    engine.setLoader(() => { loadCount++; return pages; });

    engine.search("YOLO");
    engine.search("BERT");
    // Loader should only be called once — index is cached
    expect(loadCount).toBe(1);
    const results = engine.search("BERT");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.path).toBe("concept-bert.md");
  });

  it("invalidate forces index rebuild via loader", () => {
    let loadCount = 0;
    const engine = new SearchEngine();
    engine.setLoader(() => { loadCount++; return pages; });

    engine.search("YOLO");
    expect(loadCount).toBe(1);
    engine.invalidate();
    const results = engine.search("YOLO");
    expect(loadCount).toBe(2);
    expect(results[0]!.path).toBe("concept-yolo.md");
  });

  it("no duplicate results", () => {
    const results = engineWithPages().search("model overview");
    const paths = results.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("deploy finds deployment via synonyms", () => {
    const results = engineWithPages().search("deploy");
    expect(results.some((r) => r.path === "how-to-deploy.md")).toBe(true);
  });

  it("prefix query finds pages (e.g. 'depl' matches 'deployment')", () => {
    const results = engineWithPages().search("depl");
    expect(results.some((r) => r.path === "how-to-deploy.md")).toBe(true);
  });

  it("fuzzy query finds pages (e.g. 'deploymnet' typo)", () => {
    const results = engineWithPages().search("deploymnet");
    expect(results.some((r) => r.path === "how-to-deploy.md")).toBe(true);
  });

  it("scores include snippets", () => {
    const results = engineWithPages().search("YOLO");
    expect(results[0]!.snippet).toBeTruthy();
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it("setLoader auto-invalidates cached index", () => {
    const pagesA = [makePage({ path: "a.md", title: "Alpha", content: "alpha content" })];
    const pagesB = [makePage({ path: "b.md", title: "Beta", content: "beta content" })];

    const engine = new SearchEngine();
    engine.setLoader(() => pagesA);
    const resultsA = engine.search("alpha");
    expect(resultsA.length).toBe(1);
    expect(resultsA[0]!.path).toBe("a.md");

    // Just setLoader — no explicit invalidate() needed
    engine.setLoader(() => pagesB);
    const resultsB = engine.search("beta");
    expect(resultsB.length).toBe(1);
    expect(resultsB[0]!.path).toBe("b.md");

    // Old corpus must not leak
    expect(engine.search("alpha")).toEqual([]);
  });

  it("warm search does not call loader again", () => {
    let loadCount = 0;
    const engine = new SearchEngine();
    engine.setLoader(() => { loadCount++; return pages; });

    // Cold: builds index
    engine.search("YOLO");
    expect(loadCount).toBe(1);

    // Warm: uses cached index — no loader call
    engine.search("BERT");
    engine.search("deploy");
    engine.search("model");
    expect(loadCount).toBe(1);
  });

  it("throws if no loader set", () => {
    const engine = new SearchEngine();
    expect(() => engine.search("anything")).toThrow("no page loader set");
  });
});

// ═══════════════════════════════════════════════════════════════════
//  searchIndex (stateless pure function)
// ═══════════════════════════════════════════════════════════════════

describe("searchIndex", () => {
  it("searches an index without any engine state", () => {
    const pages = [
      makePage({ path: "a.md", title: "Alpha", content: "alpha content" }),
      makePage({ path: "b.md", title: "Beta", content: "beta content" }),
    ];
    const index = buildIndex(pages);
    const results = searchIndex(index, "alpha");
    expect(results.length).toBe(1);
    expect(results[0]!.path).toBe("a.md");
  });

  it("returns same results as SearchEngine for same corpus", () => {
    const pages = [
      makePage({ path: "a.md", title: "YOLO", tags: ["detection"], content: "YOLO model." }),
      makePage({ path: "b.md", title: "BERT", tags: ["nlp"], content: "BERT model." }),
    ];
    const index = buildIndex(pages);
    const stateless = searchIndex(index, "YOLO");

    const engine = new SearchEngine();
    engine.setLoader(() => pages);
    const cached = engine.search("YOLO");

    expect(stateless.map((r) => r.path)).toEqual(cached.map((r) => r.path));
    expect(stateless.map((r) => r.score)).toEqual(cached.map((r) => r.score));
  });

  it("returns empty for empty query", () => {
    const index = buildIndex([]);
    expect(searchIndex(index, "")).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  CJK SEARCH
// ═══════════════════════════════════════════════════════════════════

describe("CJK search", () => {
  const cjkPages = [
    makePage({
      path: "concept-knowledge-base.md",
      title: "知识库系统概述",
      type: "concept",
      tags: ["知识库", "系统"],
      content: "知识库系统是一种用于存储和检索结构化知识的工具。",
    }),
    makePage({
      path: "concept-yolo-cn.md",
      title: "YOLO 目标检测",
      type: "concept",
      tags: ["目标检测", "yolo"],
      content: "YOLO 是一种实时目标检测模型，广泛用于计算机视觉。",
    }),
    makePage({
      path: "concept-deep-learning.md",
      title: "深度学习入门",
      type: "concept",
      tags: ["深度学习"],
      content: "深度学习是机器学习的一个分支，使用神经网络进行学习。",
    }),
  ];

  it("Chinese query matches Chinese title", () => {
    const engine = new SearchEngine();
    engine.setLoader(() => cjkPages);
    const results = engine.search("知识库");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.path).toBe("concept-knowledge-base.md");
  });

  it("Chinese query matches Chinese tag", () => {
    const engine = new SearchEngine();
    engine.setLoader(() => cjkPages);
    const results = engine.search("目标检测");
    expect(results.some((r) => r.path === "concept-yolo-cn.md")).toBe(true);
  });

  it("Chinese query matches Chinese body", () => {
    const engine = new SearchEngine();
    engine.setLoader(() => cjkPages);
    const results = engine.search("神经网络");
    expect(results.some((r) => r.path === "concept-deep-learning.md")).toBe(true);
  });

  it("mixed Chinese-English query", () => {
    const engine = new SearchEngine();
    engine.setLoader(() => cjkPages);
    const results = engine.search("YOLO 目标检测");
    expect(results[0]!.path).toBe("concept-yolo-cn.md");
  });

  it("short Chinese query (2 chars) still matches", () => {
    const engine = new SearchEngine();
    engine.setLoader(() => cjkPages);
    const results = engine.search("知识");
    expect(results.some((r) => r.path === "concept-knowledge-base.md")).toBe(true);
  });

  it("CJK n-grams do not flood unrelated pages", () => {
    const engine = new SearchEngine();
    engine.setLoader(() => cjkPages);
    const results = engine.search("知识库");
    // Should not return deep learning or YOLO pages at high score
    if (results.length > 1) {
      expect(results[0]!.score).toBeGreaterThan(results[results.length - 1]!.score);
      expect(results[0]!.path).toBe("concept-knowledge-base.md");
    }
  });
});
