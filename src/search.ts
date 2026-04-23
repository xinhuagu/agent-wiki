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

interface FieldTF {
  title: number;
  tags: number;
  slug: number;
  frontmatter: number;
  body: number;
}

/** Postings map: term → (docPath → per-field term frequencies). */
type PostingsMap = Map<string, Map<string, FieldTF>>;

export interface SearchIndex {
  docs: Map<string, SearchDoc>;
  postings: PostingsMap;
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
  /** The ## heading of the section containing the best match, if any. */
  section?: string;
  /** Per-field match signals, explaining *why* the page matched. Present when
   *  results are produced by `searchIndex` / `SearchEngine.search`. */
  match_quality?: MatchQuality;
  /** Human-readable reasons the page matched (e.g. "title match", "fuzzy match"). */
  match_reasons?: string[];
}

/** Structured match signals for a single result. Lets agents distinguish a
 *  strong title/tag anchor from a weak body-only or fuzzy-only hit. */
export interface MatchQuality {
  title_hit: boolean;
  tag_hit: boolean;
  slug_hit: boolean;
  /** At least one section heading in the body contains a query term. */
  section_hit: boolean;
  /** True if the match has no anchor in title, tag, slug, or section heading —
   *  i.e. only body text (or frontmatter) matched. */
  body_only: boolean;
  /** True if the only matches are fuzzy (typo-corrected) — no exact, synonym,
   *  phrase, or prefix hits contributed. */
  fuzzy_only: boolean;
  /** Fraction of original query terms (0..1) that matched the page in any form. */
  query_term_coverage: number;
}

/** Result-set level retrieval-quality signal. Deterministic, rule-based. */
export interface RetrievalSignal {
  /** "high" = strong anchor + good coverage; "medium" = partial anchor;
   *  "low" = weak/body-only/fuzzy-only or no clear leader; "none" = zero results. */
  confidence: "high" | "medium" | "low" | "none";
  low_confidence: boolean;
  /** Suggest the agent abstain (or verify carefully) rather than answering. */
  abstain_recommended: boolean;
  /** True only when retrieval looks answer-ready on its own. For
   *  `wiki_search_read`, callers may upgrade this after reading top pages. */
  evidence_sufficient: boolean;
  reason: string;
  suggestion: string;
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

// ── CJK detection ────────────────────────────────────────────────

/** Regex matching CJK Unified Ideographs + extensions + Kana + Hangul. */
const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af]/;
const CJK_RUN_RE = /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af]+/g;

/** Check whether a string contains CJK characters. */
export function isCJK(text: string): boolean {
  return CJK_RE.test(text);
}

// ── Intl.Segmenter (Node >= 16) ──────────────────────────────────

let zhSegmenter: Intl.Segmenter | null = null;
function getZhSegmenter(): Intl.Segmenter | null {
  if (zhSegmenter) return zhSegmenter;
  try {
    zhSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
    return zhSegmenter;
  } catch {
    return null;
  }
}

/** Segment CJK text using Intl.Segmenter. Returns word-level tokens. */
function segmentCJK(text: string): string[] {
  const seg = getZhSegmenter();
  if (!seg) return [];
  const words: string[] = [];
  for (const { segment, isWordLike } of seg.segment(text)) {
    if (isWordLike && segment.trim().length > 0) {
      words.push(segment);
    }
  }
  return words;
}

/** Generate 2-gram and 3-gram tokens from a CJK string. */
export function cjkNgrams(text: string): string[] {
  const grams: string[] = [];
  const chars = [...text]; // handle surrogate pairs
  for (let i = 0; i < chars.length - 1; i++) {
    grams.push(chars.slice(i, i + 2).join(""));
    if (i < chars.length - 2) {
      grams.push(chars.slice(i, i + 3).join(""));
    }
  }
  return grams;
}

// ── Tokenization & Normalization ──────────────────────────────────

/** Normalize text: lowercase, full-width → half-width, strip punctuation. */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\uff01-\uff5e]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    )
    .replace(/[_\-/.,:;!?'"()\[\]{}<>|\\@#$%^&*+=~`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Script-aware tokenization.
 *  - Latin/ASCII: split on whitespace and separators.
 *  - CJK runs: segment with Intl.Segmenter, then add n-gram fallback.
 *  - Mixed text: split into script runs, tokenize each separately. */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const normalized = normalizeText(text);
  if (!isCJK(normalized)) {
    // Pure Latin path — fast
    return normalized.split(" ").filter((t) => t.length > 0);
  }

  // Mixed or pure CJK: split into script runs
  const tokens: string[] = [];
  let remaining = normalized;

  while (remaining.length > 0) {
    const cjkMatch = CJK_RUN_RE.exec(remaining);
    if (!cjkMatch) {
      // Rest is Latin
      for (const t of remaining.split(" ")) {
        if (t.length > 0) tokens.push(t);
      }
      break;
    }

    // Latin text before the CJK run
    const before = remaining.slice(0, cjkMatch.index);
    for (const t of before.split(" ")) {
      if (t.length > 0) tokens.push(t);
    }

    // CJK run
    const cjkText = cjkMatch[0];
    // Keep full CJK run as a token for exact phrase matching
    if (cjkText.length > 1) tokens.push(cjkText);
    // Intl.Segmenter words
    const words = segmentCJK(cjkText);
    for (const w of words) {
      if (!tokens.includes(w)) tokens.push(w);
    }
    // N-gram fallback (lower priority, but ensures partial matches)
    if (cjkText.length >= 2) {
      for (const gram of cjkNgrams(cjkText)) {
        if (!tokens.includes(gram)) tokens.push(gram);
      }
    }

    remaining = remaining.slice(cjkMatch.index + cjkText.length);
    CJK_RUN_RE.lastIndex = 0; // reset regex
  }

  return tokens;
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

/** Build an inverted index from a collection of pages.
 *  Postings are stored as Map<term, Map<docPath, FieldTF>> for O(1) lookup. */
export function buildIndex(pages: Iterable<WikiPage>): SearchIndex {
  const docs = new Map<string, SearchDoc>();
  const postings: PostingsMap = new Map();
  const docFreq = new Map<string, number>();

  const totals = { title: 0, tags: 0, slug: 0, frontmatter: 0, body: 0 };

  for (const page of pages) {
    const doc = buildSearchDoc(page);
    docs.set(doc.path, doc);

    for (const field of Object.keys(totals) as FieldName[]) {
      totals[field] += doc.lengths[field];
    }

    const seenTerms = new Set<string>();

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
        let docMap = postings.get(term);
        if (!docMap) {
          docMap = new Map();
          postings.set(term, docMap);
        }
        let tf = docMap.get(doc.path);
        if (!tf) {
          tf = { title: 0, tags: 0, slug: 0, frontmatter: 0, body: 0 };
          docMap.set(doc.path, tf);
        }
        tf[field] = count;
      }
    }

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

/** Internal breakdown returned by `scoreDocDetailed` — surfaces the scoring
 *  signals used to populate `match_quality` on search results. */
export interface ScoreBreakdown {
  score: number;
  fieldHits: Record<FieldName, boolean>;
  /** Whether each scoring layer contributed to the score. */
  matchLayers: {
    bm25: boolean;       // direct postings match on an original query term
    synonym: boolean;    // postings match via synonym expansion
    prefix: boolean;     // prefix match in title/tag/slug
    fuzzy: boolean;      // edit-distance match in title/tag/slug
    phrase: boolean;     // exact phrase hit in title/slug/body
  };
  /** Fraction of unique original query terms that matched in any form (0..1). */
  termCoverage: number;
  /** True if at least one heading line in the body contains a query term. */
  sectionHit: boolean;
}

/** Score a document against query terms using field-weighted BM25, and return
 *  a full breakdown of which signals contributed. Also used by `searchIndex`
 *  to populate `match_quality` on results. */
export function scoreDocDetailed(
  doc: SearchDoc,
  queryTerms: string[],
  expandedTerms: string[],
  index: SearchIndex,
): ScoreBreakdown {
  let score = 0;
  const fields: FieldName[] = ["title", "tags", "slug", "frontmatter", "body"];

  const fieldHits: Record<FieldName, boolean> = {
    title: false, tags: false, slug: false, frontmatter: false, body: false,
  };
  const matchLayers = {
    bm25: false, synonym: false, prefix: false, fuzzy: false, phrase: false,
  };
  const matchedOriginals = new Set<string>();

  // BM25 scoring for each term
  for (const term of expandedTerms) {
    const docMap = index.postings.get(term);
    if (!docMap) continue;
    const tf = docMap.get(doc.path);
    if (!tf) continue;
    const df = index.docFreq.get(term) ?? 0;
    const isOriginal = queryTerms.includes(term);
    const expansionPenalty = isOriginal ? 1.0 : 0.4;

    let termContributed = false;
    for (const field of fields) {
      const fieldScore = bm25Field(
        tf[field],
        df,
        index.docCount,
        doc.lengths[field],
        index.avgFieldLength[field],
      );
      if (fieldScore > 0) {
        fieldHits[field] = true;
        termContributed = true;
      }
      score += fieldScore * FIELD_WEIGHTS[field] * expansionPenalty;
    }

    if (termContributed) {
      if (isOriginal) {
        matchLayers.bm25 = true;
        matchedOriginals.add(term);
      } else {
        matchLayers.synonym = true;
        // Attribute the synonym hit back to the original(s) that expanded to it
        for (const orig of queryTerms) {
          const syns = SYNONYMS[orig];
          if (!syns) continue;
          for (const syn of syns) {
            if (tokenize(syn).includes(term)) { matchedOriginals.add(orig); break; }
          }
        }
      }
    }
  }

  // ── Bonus: exact phrase match ──
  const originalPhrase = queryTerms.join(" ");
  if (originalPhrase.length > 0) {
    const titleLower = doc.title.toLowerCase();
    const slugLower = doc.slug.toLowerCase();
    const bodyLower = doc.body.toLowerCase();

    if (titleLower.includes(originalPhrase)) {
      score += 8; matchLayers.phrase = true; fieldHits.title = true;
    }
    if (slugLower.includes(originalPhrase.replace(/\s+/g, "-"))) {
      score += 6; matchLayers.phrase = true; fieldHits.slug = true;
    }
    if (bodyLower.includes(originalPhrase)) {
      score += 3; matchLayers.phrase = true; fieldHits.body = true;
    }
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
        fieldHits[field] = true;
        matchLayers.prefix = true;
        matchedOriginals.add(term);
      }
    }
  }

  // ── Fuzzy matching in high-signal fields (Latin only — skip CJK) ──
  for (const term of queryTerms) {
    if (isCJK(term)) continue; // CJK uses n-gram overlap, not edit distance
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
        fieldHits[field] = true;
        matchLayers.fuzzy = true;
        matchedOriginals.add(term);
      }
    }
  }

  // ── Query term coverage ──
  const uniqueOriginals = new Set(queryTerms);
  const termCoverage = uniqueOriginals.size > 0
    ? matchedOriginals.size / uniqueOriginals.size
    : 0;

  // ── Section-heading hit ──
  const sectionHit = hasSectionQueryHit(doc.body, queryTerms);

  return { score, fieldHits, matchLayers, termCoverage, sectionHit };
}

/** Score a document against query terms. Thin wrapper over `scoreDocDetailed`
 *  for call sites that only need the numeric score. */
export function scoreDoc(
  doc: SearchDoc,
  queryTerms: string[],
  expandedTerms: string[],
  index: SearchIndex,
): number {
  return scoreDocDetailed(doc, queryTerms, expandedTerms, index).score;
}

/** Does any heading line in `body` contain at least one query term?
 *  Skips headings inside fenced code blocks. Used for section-heading match
 *  detection in retrieval quality signals. */
function hasSectionQueryHit(body: string, queryTerms: string[]): boolean {
  if (queryTerms.length === 0 || body.length === 0) return false;
  const lines = body.split("\n");
  let inCodeBlock = false;
  for (const line of lines) {
    if (/^(`{3,}|~{3,})/.test(line)) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock) continue;
    if (!/^#{1,6}\s/.test(line)) continue;
    const headingLower = line.toLowerCase();
    for (const t of queryTerms) {
      if (t.length > 0 && headingLower.includes(t)) return true;
    }
  }
  return false;
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

/** Find the nearest heading above a given character offset in body text.
 *  Skips heading-like lines inside fenced code blocks (``` or ~~~). */
export function findSection(body: string, charOffset: number): string | undefined {
  const lines = body.slice(0, charOffset).split("\n");
  let inCodeBlock = false;
  let lastHeading: string | undefined;
  for (const line of lines) {
    if (/^(`{3,}|~{3,})/.test(line)) { inCodeBlock = !inCodeBlock; continue; }
    if (!inCodeBlock && /^#{1,6}\s/.test(line.trimEnd())) lastHeading = line.trimEnd();
  }
  return lastHeading;
}

/** Generate a context snippet around the best matching region.
 *  Returns { snippet, section } where section is the ## heading containing the match. */
export function makeSnippet(doc: SearchDoc, queryTerms: string[]): { snippet: string; section?: string } {
  const text = doc.body.toLowerCase();
  if (text.length === 0) return { snippet: doc.title };

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
    return {
      snippet: doc.body.slice(0, end).trim() + (end < doc.body.length ? "..." : ""),
    };
  }

  const start = Math.max(0, bestPos - 60);
  const end = Math.min(text.length, bestPos + bestTerm.length + 90);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return {
    snippet: prefix + doc.body.slice(start, end).trim() + suffix,
    section: findSection(doc.body, bestPos),
  };
}

// ── Hybrid search configuration ──────────────────────────────────

export interface SearchConfig {
  /** Enable hybrid BM25+vector scoring. Requires @xenova/transformers. Default: false. */
  hybrid: boolean;
  /** BM25 score weight in hybrid mode (0–1). Default: 0.6. */
  bm25Weight: number;
  /** Vector similarity weight in hybrid mode (0–1). Default: 0.4. */
  vectorWeight: number;
  /** Sentence-transformer model ID for embeddings. Default: "Xenova/all-MiniLM-L6-v2". */
  model: string;
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  hybrid: false,
  bm25Weight: 0.6,
  vectorWeight: 0.4,
  model: "Xenova/all-MiniLM-L6-v2",
};

// ── Vector utilities ──────────────────────────────────────────────

/** Cosine similarity between two equal-length float vectors. Returns 0 on dimension mismatch. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Search Engine ─────────────────────────────────────────────────

// ── Stateless search function ─────────────────────────────────────

/** Pure-function search against a pre-built index.
 *  Uses postings union to derive candidate docs — only scores documents
 *  that contain at least one query term, not the full corpus. */
export function searchIndex(
  index: SearchIndex,
  query: string,
  limit = 10,
): SearchResult[] {
  const queryTerms = normalizeQuery(query);
  if (queryTerms.length === 0) return [];
  const expandedTerms = expandTerms(queryTerms);

  // Derive candidate documents from postings union + prefix/fuzzy expansion.
  // Exact and synonym matches come from direct postings lookup (O(1) per term).
  // Prefix and fuzzy matches scan the postings key set once per query term.
  const candidates = new Set<string>();

  // 1. Exact + synonym hits
  for (const term of expandedTerms) {
    const docMap = index.postings.get(term);
    if (docMap) {
      for (const path of docMap.keys()) candidates.add(path);
    }
  }

  // 2. Prefix + fuzzy hits (scan indexed terms, collect matching docs)
  for (const term of queryTerms) {
    if (term.length < 2) continue;
    const maxDist = isCJK(term) ? 0 : fuzzyThreshold(term);

    for (const [indexedTerm, docMap] of index.postings) {
      if (candidates.size > 0 && docMap.size === 0) continue;
      // Skip if already an exact/synonym hit
      if (expandedTerms.includes(indexedTerm)) continue;
      // Prefix match
      if (indexedTerm.startsWith(term) && indexedTerm !== term) {
        for (const path of docMap.keys()) candidates.add(path);
        continue;
      }
      // Fuzzy match (only for non-CJK terms above threshold)
      if (maxDist > 0 && editDistance(term, indexedTerm) <= maxDist) {
        for (const path of docMap.keys()) candidates.add(path);
      }
    }
  }

  const results: SearchResult[] = [];
  for (const path of candidates) {
    const doc = index.docs.get(path);
    if (!doc) continue;
    const breakdown = scoreDocDetailed(doc, queryTerms, expandedTerms, index);
    if (breakdown.score > 0) {
      const { snippet, section } = makeSnippet(doc, queryTerms);
      const { match_quality, match_reasons } = deriveMatchQuality(breakdown);
      results.push({
        path: doc.path,
        score: Math.round(breakdown.score * 100) / 100,
        snippet,
        section,
        match_quality,
        match_reasons,
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/** Derive the user-facing `match_quality` + `match_reasons` from a
 *  `ScoreBreakdown`. Pure, no index access. */
function deriveMatchQuality(
  breakdown: ScoreBreakdown,
): { match_quality: MatchQuality; match_reasons: string[] } {
  const { fieldHits, matchLayers, termCoverage, sectionHit } = breakdown;
  const anyStructuredHit = fieldHits.title || fieldHits.tags || fieldHits.slug || sectionHit;
  // fuzzy_only: the only contributing layer was fuzzy matching
  const fuzzyOnly =
    matchLayers.fuzzy &&
    !matchLayers.bm25 &&
    !matchLayers.synonym &&
    !matchLayers.prefix &&
    !matchLayers.phrase;

  const match_quality: MatchQuality = {
    title_hit: fieldHits.title,
    tag_hit: fieldHits.tags,
    slug_hit: fieldHits.slug,
    section_hit: sectionHit,
    body_only: !anyStructuredHit,
    fuzzy_only: fuzzyOnly,
    query_term_coverage: Math.round(termCoverage * 100) / 100,
  };

  const match_reasons: string[] = [];
  if (match_quality.title_hit) match_reasons.push("title match");
  if (match_quality.tag_hit) match_reasons.push("tag match");
  if (match_quality.slug_hit) match_reasons.push("slug match");
  if (match_quality.section_hit) match_reasons.push("section heading match");
  if (matchLayers.phrase) match_reasons.push("exact phrase match");
  if (matchLayers.synonym && !matchLayers.bm25) match_reasons.push("synonym-only match");
  if (match_quality.fuzzy_only) match_reasons.push("fuzzy (typo-corrected) match only");
  if (match_quality.body_only && !match_quality.fuzzy_only) match_reasons.push("body-only match");
  if (match_reasons.length === 0 && fieldHits.body) match_reasons.push("body match");

  return { match_quality, match_reasons };
}

// ── Retrieval quality signal ──────────────────────────────────────

/** Evaluate result-set level retrieval quality. Pure, deterministic, rule-based.
 *
 *  Looks at the top result's `match_quality` (title/tag/slug/section anchors,
 *  body-only and fuzzy-only flags, query term coverage) and the separation
 *  between #1 and #2 by score. No absolute BM25 thresholds — scales aren't
 *  stable across queries.
 *
 *  - "high"   → strong anchor (title/tag/slug) + ≥50% term coverage + not fuzzy-only
 *  - "medium" → anchor is section-only or coverage is partial
 *  - "low"    → body-only, fuzzy-only, poor coverage, or #1 doesn't clearly
 *               outrank #2 (tight clustering is treated as ambiguity, which
 *               demotes confidence to "low" regardless of anchor strength)
 *  - "none"   → no results at all
 *
 *  `abstain_recommended` fires on "low" / "none".
 *
 *  `evidence_sufficient` is ALWAYS `false` here — a retrieval hit is not the
 *  same as verified content. Only callers that successfully read a top page
 *  with a strong anchor (e.g. `wiki_search_read`) are allowed to upgrade it. */
export function evaluateRetrievalSignal(results: SearchResult[]): RetrievalSignal {
  if (results.length === 0) {
    return {
      confidence: "none",
      low_confidence: true,
      abstain_recommended: true,
      evidence_sufficient: false,
      reason: "No matching pages were found.",
      suggestion: "Treat this as a knowledge gap. Create a new page with wiki_write, or refine the query.",
    };
  }

  const top = results[0]!;
  const q = top.match_quality;
  const reasons: string[] = [];

  if (!q) {
    // SearchResult without breakdown — be conservative
    return {
      confidence: "medium",
      low_confidence: false,
      abstain_recommended: false,
      evidence_sufficient: false,
      reason: "Top result has no structured match-quality data.",
      suggestion: "Read the top-ranked pages to confirm details before citing.",
    };
  }

  const strongField = q.title_hit || q.tag_hit || q.slug_hit;
  let confidence: "high" | "medium" | "low";

  if (strongField && q.query_term_coverage >= 0.5 && !q.fuzzy_only) {
    confidence = "high";
    const hits: string[] = [];
    if (q.title_hit) hits.push("title");
    if (q.tag_hit) hits.push("tag");
    if (q.slug_hit) hits.push("slug");
    reasons.push(`Top result has ${hits.join("/")} match`);
  } else if ((strongField || q.section_hit) && !q.fuzzy_only) {
    confidence = "medium";
    if (!strongField && q.section_hit) {
      reasons.push("Top result has a section-heading match but no title/tag/slug anchor");
    } else if (q.query_term_coverage < 0.5) {
      reasons.push(`Top result matches only ${Math.round(q.query_term_coverage * 100)}% of query terms`);
    } else {
      reasons.push("Top result has a partial anchor");
    }
  } else {
    confidence = "low";
    if (q.fuzzy_only) {
      reasons.push("Top match relies on fuzzy (typo-corrected) matches only");
    } else if (q.body_only) {
      reasons.push("Top match is body-only — no anchor in title, tag, slug, or section heading");
    }
    if (q.query_term_coverage < 0.5) {
      reasons.push(`only ${Math.round(q.query_term_coverage * 100)}% of query terms matched`);
    }
    if (reasons.length === 0) {
      reasons.push("Top match has no strong field-level anchor");
    }
  }

  // Top-1 vs top-2 separation: if results are tightly clustered, there's no
  // clear leader — treat that as ambiguity and collapse to "low" so abstain
  // fires, regardless of anchor strength. (Otherwise an ambiguous two-page
  // tie between equally-anchored pages would slip through as medium and the
  // agent would be told it's safe to answer from retrieval alone.)
  if (results.length > 1) {
    const second = results[1]!.score;
    const ratio = top.score / Math.max(second, 0.01);
    if (ratio < 1.2) {
      reasons.push(`top result does not clearly outrank #2 (score ratio ${ratio.toFixed(2)})`);
      confidence = "low";
    }
  }

  const low_confidence = confidence === "low";
  const abstain_recommended = low_confidence;
  // Retrieval alone is never answer-ready. Callers that have read top pages
  // (wiki_search_read) may upgrade this after verifying content.
  const evidence_sufficient = false;

  return {
    confidence,
    low_confidence,
    abstain_recommended,
    evidence_sufficient,
    reason: reasons.join("; "),
    suggestion: abstain_recommended
      ? "Verify by reading the top pages, refine the query, or treat this as a knowledge gap."
      : "Read the top-ranked pages to confirm details before citing.",
  };
}

// ── Search Engine (cached, loader-based) ──────────────────────────

/** Cached search engine with lazy index build and incremental invalidation.
 *
 *  The engine owns the corpus snapshot via a loader function.
 *  The loader is only invoked when the index needs to be (re)built.
 *
 *  Hybrid mode: set `config.hybrid = true` and inject page vectors via
 *  `setVectors()` / `updateVector()`. Requires @xenova/transformers installed.
 *
 *  For stateless / ad-hoc searches, use `searchIndex(buildIndex(pages), query)`. */
export class SearchEngine {
  private index: SearchIndex | null = null;
  private loader: (() => WikiPage[]) | null = null;
  private config: SearchConfig = { ...DEFAULT_SEARCH_CONFIG };
  // page path → embedding vector (set externally, persisted in wiki/.search-vectors.json)
  private vectors = new Map<string, number[]>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private embedPipeline: any = null;

  /** Configure hybrid search. Call before first search. */
  setConfig(config: Partial<SearchConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Replace the entire vector index (used on startup to restore persisted state). */
  setVectors(vectors: Map<string, number[]>): void {
    this.vectors = vectors;
  }

  /** Add or update the embedding for a single page. */
  updateVector(path: string, embedding: number[]): void {
    this.vectors.set(path, embedding);
  }

  /** Remove the embedding for a deleted page. */
  removeVector(path: string): void {
    this.vectors.delete(path);
  }

  /** Return a snapshot of all stored vectors (for persistence). */
  getVectors(): Map<string, number[]> {
    return this.vectors;
  }

  /** Return the number of stored page vectors. */
  getVectorCount(): number {
    return this.vectors.size;
  }

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

  /** Compute an embedding for `text` using the configured transformers.js model.
   *  Lazy-loads the pipeline on first call.
   *  Throws if @xenova/transformers is not installed. */
  async embedText(text: string): Promise<number[]> {
    if (!this.embedPipeline) {
      let pipelineFn: (task: string, model: string) => Promise<unknown>;
      try {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore — @xenova/transformers is an optional dependency
        const mod = await import("@xenova/transformers");
        pipelineFn = (mod as any).pipeline;
      } catch {
        throw new Error(
          "Hybrid search requires @xenova/transformers. " +
          "Run: npm install @xenova/transformers"
        );
      }
      this.embedPipeline = await pipelineFn("feature-extraction", this.config.model);
    }
    const output = await (this.embedPipeline as any)(text, { pooling: "mean", normalize: true });
    return Array.from(output.data as Float32Array);
  }

  /** Execute a BM25 search query against the cached index (synchronous). */
  search(query: string, limit = 10): SearchResult[] {
    return searchIndex(this.ensureIndex(), query, limit);
  }

  /** Hybrid BM25+vector search (async).
   *  Computes a query embedding, re-ranks BM25 candidates by cosine similarity,
   *  and blends scores: final = bm25_weight × norm_bm25 + vector_weight × cosine.
   *  Falls back to pure BM25 if @xenova/transformers is unavailable or embedding fails. */
  async searchHybrid(query: string, limit = 10): Promise<SearchResult[]> {
    const index = this.ensureIndex();
    // Fetch 3× candidates so re-ranking has room to promote vector-close docs
    const bm25Results = searchIndex(index, query, limit * 3);

    if (this.vectors.size === 0 || bm25Results.length === 0) {
      return bm25Results.slice(0, limit);
    }

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embedText(query);
    } catch {
      return bm25Results.slice(0, limit); // embedding failed → pure BM25
    }

    const maxBm25 = bm25Results[0]!.score;
    const scored = bm25Results.map(r => {
      const docVec = this.vectors.get(r.path);
      const vectorScore = docVec ? cosineSimilarity(queryEmbedding, docVec) : 0;
      const normalizedBm25 = maxBm25 > 0 ? r.score / maxBm25 : 0;
      const hybrid = normalizedBm25 * this.config.bm25Weight + vectorScore * this.config.vectorWeight;
      return { ...r, score: Math.round(hybrid * 10000) / 10000 };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}
