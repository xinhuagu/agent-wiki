/**
 * Local search engine — BM25 lexical ranking with inverted index.
 *
 * Zero LLM dependency. Deterministic, explainable, low-latency.
 *
 * Features:
 *   - Field-weighted BM25 scoring (title, tags, slug, frontmatter, body)
 *   - Inverted index with lazy build and incremental invalidation
 *   - Query normalization and local synonym expansion
 *   - Prefix matching in high-signal fields (title, tags, slug)
 *   - Fuzzy matching (edit distance) for typo tolerance
 *   - Exact phrase boosts
 */

import { basename, extname } from "node:path";
import type { WikiPage } from "./wiki.js";

// ── Types ─────────────────────────────────────────────────────────

export interface SearchDoc {
  path: string;
  title: string;
  slug: string;
  type?: string;
  tags: string[];
  body: string;
  updated?: string;
  fields: {
    titleTerms: string[];
    tagTerms: string[];
    slugTerms: string[];
    frontmatterTerms: string[];
    bodyTerms: string[];
  };
  lengths: {
    title: number;
    tags: number;
    slug: number;
    frontmatter: number;
    body: number;
  };
}

interface Posting {
  path: string;
  tf: {
    title: number;
    tags: number;
    slug: number;
    frontmatter: number;
    body: number;
  };
}

export interface SearchIndex {
  docs: Map<string, SearchDoc>;
  postings: Map<string, Posting[]>;
  docFreq: Map<string, number>;
  docCount: number;
  avgFieldLength: {
    title: number;
    tags: number;
    slug: number;
    frontmatter: number;
    body: number;
  };
}

export interface SearchResult {
  path: string;
  score: number;
  snippet: string;
}

type FieldName = "title" | "tags" | "slug" | "frontmatter" | "body";

// ── Constants ─────────────────────────────────────────────────────

const FIELD_WEIGHTS: Record<FieldName, number> = {
  title: 4.0,
  tags: 3.0,
  slug: 3.0,
  frontmatter: 1.5,
  body: 1.0,
};

// BM25 parameters
const BM25_K1 = 1.2;
const BM25_B = 0.75;

// ── Synonym table ─────────────────────────────────────────────────

const SYNONYMS: Record<string, string[]> = {
  deploy: ["deployment", "release", "publish"],
  deployment: ["deploy", "release"],
  llm: ["language model", "large language model"],
  rag: ["retrieval augmented generation"],
  ci: ["continuous integration"],
  cd: ["continuous delivery", "continuous deployment"],
  api: ["interface", "endpoint"],
  ml: ["machine learning"],
  dl: ["deep learning"],
  cv: ["computer vision"],
  nlp: ["natural language processing"],
  gpu: ["graphics processing unit"],
  cpu: ["central processing unit"],
  k8s: ["kubernetes"],
  db: ["database"],
  auth: ["authentication", "authorization"],
  config: ["configuration"],
  env: ["environment"],
  repo: ["repository"],
  deps: ["dependencies"],
  docs: ["documentation"],
  fn: ["function"],
  impl: ["implementation"],
  infra: ["infrastructure"],
};

// ── Tokenization & Normalization ──────────────────────────────────

/** Normalize and tokenize text into search terms. */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    // Normalize full-width to half-width (CJK punctuation)
    .replace(/[\uff01-\uff5e]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    )
    // Normalize separators to spaces
    .replace(/[_\-/.,:;!?'"()\[\]{}<>|\\@#$%^&*+=~`]+/g, " ")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 0);
}

/** Normalize a query string into terms. */
export function normalizeQuery(query: string): string[] {
  return tokenize(query);
}

/** Expand terms with local synonyms. Returns deduplicated expanded list. */
export function expandTerms(terms: string[]): string[] {
  const expanded = new Set(terms);
  for (const term of terms) {
    const syns = SYNONYMS[term];
    if (syns) {
      for (const syn of syns) {
        // Multi-word synonyms: add as individual tokens
        for (const t of tokenize(syn)) {
          expanded.add(t);
        }
      }
    }
  }
  return [...expanded];
}

// ── Search Document Builder ───────────────────────────────────────

/** Build a SearchDoc from a WikiPage. */
export function buildSearchDoc(page: WikiPage): SearchDoc {
  const slug = basename(page.path, extname(page.path));

  const frontmatterText = Object.entries(page.frontmatter)
    .filter(([k]) => !["title", "type", "tags", "created", "updated", "sources", "derived_from"].includes(k))
    .map(([, v]) => String(v))
    .join(" ");

  const titleTerms = tokenize(page.title);
  const tagTerms = page.tags.flatMap((t) => tokenize(t));
  const slugTerms = tokenize(slug);
  const frontmatterTerms = tokenize(frontmatterText);
  const bodyTerms = tokenize(page.content);

  return {
    path: page.path,
    title: page.title,
    slug,
    type: page.type,
    tags: page.tags,
    body: page.content,
    updated: page.updated,
    fields: { titleTerms, tagTerms, slugTerms, frontmatterTerms, bodyTerms },
    lengths: {
      title: titleTerms.length,
      tags: tagTerms.length,
      slug: slugTerms.length,
      frontmatter: frontmatterTerms.length,
      body: bodyTerms.length,
    },
  };
}

// ── Inverted Index ────────────────────────────────────────────────

/** Build an inverted index from a collection of pages. */
export function buildIndex(pages: Iterable<WikiPage>): SearchIndex {
  const docs = new Map<string, SearchDoc>();
  const postings = new Map<string, Posting[]>();
  const docFreq = new Map<string, number>();

  const totals = { title: 0, tags: 0, slug: 0, frontmatter: 0, body: 0 };

  for (const page of pages) {
    const doc = buildSearchDoc(page);
    docs.set(doc.path, doc);

    // Accumulate field lengths for averages
    for (const field of Object.keys(totals) as FieldName[]) {
      totals[field] += doc.lengths[field];
    }

    // Track which terms appear in this doc (for docFreq)
    const seenTerms = new Set<string>();

    // Build postings for each field
    const tf: Posting["tf"] = { title: 0, tags: 0, slug: 0, frontmatter: 0, body: 0 };

    const fieldTermsMap: Record<FieldName, string[]> = {
      title: doc.fields.titleTerms,
      tags: doc.fields.tagTerms,
      slug: doc.fields.slugTerms,
      frontmatter: doc.fields.frontmatterTerms,
      body: doc.fields.bodyTerms,
    };

    for (const [field, terms] of Object.entries(fieldTermsMap) as [FieldName, string[]][]) {
      const termCounts = new Map<string, number>();
      for (const term of terms) {
        termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
        seenTerms.add(term);
      }

      for (const [term, count] of termCounts) {
        if (!postings.has(term)) postings.set(term, []);
        // Find or create posting for this doc
        let posting = postings.get(term)!.find((p) => p.path === doc.path);
        if (!posting) {
          posting = { path: doc.path, tf: { title: 0, tags: 0, slug: 0, frontmatter: 0, body: 0 } };
          postings.get(term)!.push(posting);
        }
        posting.tf[field] = count;
      }
    }

    // Update document frequencies
    for (const term of seenTerms) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  const docCount = docs.size;
  const avgFieldLength = {
    title: docCount > 0 ? totals.title / docCount : 1,
    tags: docCount > 0 ? totals.tags / docCount : 1,
    slug: docCount > 0 ? totals.slug / docCount : 1,
    frontmatter: docCount > 0 ? totals.frontmatter / docCount : 1,
    body: docCount > 0 ? totals.body / docCount : 1,
  };

  return { docs, postings, docFreq, docCount, avgFieldLength };
}

// ── BM25 Scoring ──────────────────────────────────────────────────

/** Compute BM25 score for a single term in a single field. */
function bm25Field(
  tf: number,
  df: number,
  docCount: number,
  fieldLen: number,
  avgFieldLen: number,
): number {
  if (tf === 0 || df === 0) return 0;
  const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
  const tfNorm = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (fieldLen / avgFieldLen)));
  return idf * tfNorm;
}

const FIELD_TO_TERMS_KEY: Record<FieldName, keyof SearchDoc["fields"]> = {
  title: "titleTerms",
  tags: "tagTerms",
  slug: "slugTerms",
  frontmatter: "frontmatterTerms",
  body: "bodyTerms",
};

/** Score a document against query terms using field-weighted BM25. */
export function scoreDoc(
  doc: SearchDoc,
  queryTerms: string[],
  expandedTerms: string[],
  index: SearchIndex,
): number {
  let score = 0;
  const fields: FieldName[] = ["title", "tags", "slug", "frontmatter", "body"];

  // BM25 scoring for each term
  for (const term of expandedTerms) {
    const postingList = index.postings.get(term);
    if (!postingList) continue;
    const posting = postingList.find((p) => p.path === doc.path);
    if (!posting) continue;
    const df = index.docFreq.get(term) ?? 0;

    for (const field of fields) {
      const fieldScore = bm25Field(
        posting.tf[field],
        df,
        index.docCount,
        doc.lengths[field],
        index.avgFieldLength[field],
      );
      // Expanded (synonym) terms get reduced weight
      const isOriginal = queryTerms.includes(term);
      const expansionPenalty = isOriginal ? 1.0 : 0.4;
      score += fieldScore * FIELD_WEIGHTS[field] * expansionPenalty;
    }
  }

  // ── Bonus: exact phrase match ──
  const originalPhrase = queryTerms.join(" ");
  if (originalPhrase.length > 0) {
    const titleLower = doc.title.toLowerCase();
    const slugLower = doc.slug.toLowerCase();
    const bodyLower = doc.body.toLowerCase();

    if (titleLower.includes(originalPhrase)) score += 8;
    if (slugLower.includes(originalPhrase.replace(/\s+/g, "-"))) score += 6;
    if (bodyLower.includes(originalPhrase)) score += 3;
  }

  // ── Bonus: all query terms present in same field ──
  for (const field of fields) {
    const fieldTerms = new Set(doc.fields[FIELD_TO_TERMS_KEY[field]]);
    if (queryTerms.length > 1 && queryTerms.every((t) => fieldTerms.has(t))) {
      score += 3;
    }
  }

  // ── Bonus: synthesis page + overview-style query ──
  if (doc.type === "synthesis") {
    const overviewWords = ["overview", "summary", "compare", "comparison", "difference", "vs"];
    if (queryTerms.some((t) => overviewWords.includes(t))) {
      score += 2;
    }
  }

  // ── Prefix matching in high-signal fields ──
  for (const term of queryTerms) {
    if (term.length < 2) continue;
    for (const field of ["title", "tags", "slug"] as FieldName[]) {
      const fieldTerms = doc.fields[FIELD_TO_TERMS_KEY[field]];
      const hasPrefix = fieldTerms.some(
        (ft) => ft.startsWith(term) && ft !== term,
      );
      if (hasPrefix) {
        score += FIELD_WEIGHTS[field] * 0.5;
      }
    }
  }

  // ── Fuzzy matching in high-signal fields ──
  for (const term of queryTerms) {
    const maxDist = fuzzyThreshold(term);
    if (maxDist === 0) continue;

    for (const field of ["title", "tags", "slug"] as FieldName[]) {
      const fieldTerms = doc.fields[FIELD_TO_TERMS_KEY[field]];
      const hasFuzzy = fieldTerms.some((ft) => {
        if (ft === term || ft.startsWith(term)) return false;
        return editDistance(term, ft) <= maxDist;
      });
      if (hasFuzzy) {
        score += FIELD_WEIGHTS[field] * 0.3;
      }
    }
  }

  return score;
}

// ── Fuzzy matching helpers ────────────────────────────────────────

/** Return max edit distance threshold for a given term length. */
export function fuzzyThreshold(term: string): number {
  if (term.length < 4) return 0;
  if (term.length <= 7) return 1;
  return 2;
}

/** Compute Levenshtein edit distance between two strings. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Optimization: if length difference exceeds max possible threshold, skip
  if (Math.abs(a.length - b.length) > 2) return Math.abs(a.length - b.length);

  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,      // deletion
        matrix[i]![j - 1]! + 1,      // insertion
        matrix[i - 1]![j - 1]! + cost, // substitution
      );
    }
  }

  return matrix[a.length]![b.length]!;
}

// ── Snippet generation ────────────────────────────────────────────

/** Generate a context snippet around the best matching region. */
export function makeSnippet(doc: SearchDoc, queryTerms: string[]): string {
  const text = doc.body.toLowerCase();
  if (text.length === 0) return doc.title;

  // Find the position of the first matching query term
  let bestPos = -1;
  let bestTerm = "";
  for (const term of queryTerms) {
    const idx = text.indexOf(term);
    if (idx !== -1 && (bestPos === -1 || idx < bestPos)) {
      bestPos = idx;
      bestTerm = term;
    }
  }

  if (bestPos === -1) {
    // No body match — return start of body
    const end = Math.min(doc.body.length, 150);
    return doc.body.slice(0, end).trim() + (end < doc.body.length ? "..." : "");
  }

  const start = Math.max(0, bestPos - 60);
  const end = Math.min(text.length, bestPos + bestTerm.length + 90);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return prefix + doc.body.slice(start, end).trim() + suffix;
}

// ── Search Engine ─────────────────────────────────────────────────

/** Main search engine with lazy index and incremental invalidation.
 *
 *  The engine owns the corpus snapshot: callers supply a loader function
 *  that is only invoked when the index needs to be (re)built. This avoids
 *  re-reading every page from disk on warm searches and prevents stale
 *  results when the engine is reused across different page sets. */
export class SearchEngine {
  private index: SearchIndex | null = null;
  private loader: (() => WikiPage[]) | null = null;

  /** Set the page loader. Invalidates any cached index so the next search rebuilds. */
  setLoader(loader: () => WikiPage[]): void {
    this.loader = loader;
    this.index = null;
  }

  /** Mark the index as needing a rebuild (after write/delete/init). */
  invalidate(): void {
    this.index = null;
  }

  /** Build or return the cached index. */
  private ensureIndex(): SearchIndex {
    if (!this.index) {
      if (!this.loader) {
        throw new Error("SearchEngine: no page loader set — call setLoader() before searching");
      }
      this.index = buildIndex(this.loader());
    }
    return this.index;
  }

  /** Execute a search query against the cached index. */
  search(query: string, limit?: number): SearchResult[];
  /** Execute a search query, building/rebuilding the index from the given pages.
   *  @deprecated Pass pages via setLoader() instead for proper caching. */
  search(pages: Iterable<WikiPage>, query: string, limit?: number): SearchResult[];
  search(
    pagesOrQuery: Iterable<WikiPage> | string,
    queryOrLimit?: string | number,
    maybeLimit?: number,
  ): SearchResult[] {
    let query: string;
    let limit: number;

    if (typeof pagesOrQuery === "string") {
      // New signature: search(query, limit?)
      query = pagesOrQuery;
      limit = (queryOrLimit as number | undefined) ?? 10;
    } else {
      // Legacy signature: search(pages, query, limit?)
      // Rebuild index from provided pages (no caching across calls)
      this.index = buildIndex(pagesOrQuery);
      query = queryOrLimit as string;
      limit = maybeLimit ?? 10;
    }

    const queryTerms = normalizeQuery(query);
    if (queryTerms.length === 0) return [];

    const expandedTerms = expandTerms(queryTerms);
    const index = this.ensureIndex();

    const results: SearchResult[] = [];

    for (const doc of index.docs.values()) {
      const score = scoreDoc(doc, queryTerms, expandedTerms, index);
      if (score > 0) {
        results.push({
          path: doc.path,
          score: Math.round(score * 100) / 100,
          snippet: makeSnippet(doc, queryTerms),
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}
