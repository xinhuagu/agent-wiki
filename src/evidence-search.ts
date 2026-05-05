/**
 * Evidence-first phase 1: derive an EvidenceEnvelope from a search result
 * list so wiki_search and wiki_search_read can signal "weak / abstain"
 * instead of treating every BM25 hit as authoritative.
 *
 * See docs/evidence-envelope.md ("Small-corpus abstain rule").
 *
 * Confidence rules (Caveat 2):
 *   - top1 below absolute floor (BM25 < 2.0)              → absent + abstain
 *   - top1 below cached corpus 30th percentile             → absent + abstain
 *   - top1 ≥ 2× top2                                       → strong
 *   - top1 < 2× top2                                       → weak
 *   - 0 results                                            → absent + abstain
 */

import type { SearchResult } from "./search.js";
import type { EvidenceEnvelope, EvidenceConfidence } from "./evidence.js";

export interface CorpusSearchStats {
  /**
   * 30th percentile of typical-query BM25 top1 scores. Computed by sampling
   * page titles as queries during wiki_admin rebuild. `null` when the corpus
   * is too small to produce a stable estimate.
   */
  p30: number | null;
  /** Number of indexed pages when the stats were computed. */
  indexedPages: number;
  /** ISO timestamp of last computation. */
  computedAt: string;
}

/** Filesystem location for the cached stats, relative to the wiki root. */
export const SEARCH_STATS_PATH = ".agent-wiki/search-distribution.json";

/** Absolute floor below which any top1 BM25 score is "weak in absolute terms". */
export const ABSOLUTE_FLOOR = 2.0;

/** top1/top2 ratio that splits "strong" from "weak". */
const TOP1_OVER_TOP2_STRONG = 2.0;

/** Below this many indexed pages, percentile cutoff is unreliable; rely on absolute floor only. */
export const SMALL_CORPUS_THRESHOLD = 20;

export function buildSearchEnvelope(
  results: SearchResult[],
  stats: CorpusSearchStats | null,
  query: string,
): EvidenceEnvelope {
  if (results.length === 0) {
    return {
      provenance: [],
      confidence: "absent",
      basis: "unsupported",
      abstain: true,
      rationale: `No matches for "${query}".`,
    };
  }

  const top1 = results[0]!.score;

  if (top1 < ABSOLUTE_FLOOR) {
    return {
      provenance: results.slice(0, 3).map((r) => ({ wikiPage: `wiki/${r.path}` })),
      confidence: "absent",
      basis: "unsupported",
      abstain: true,
      rationale:
        `Top match score ${top1.toFixed(2)} is below the absolute floor (${ABSOLUTE_FLOOR}). ` +
        `Treat as no usable result.`,
    };
  }

  const useRelativeFloor =
    stats?.p30 != null && stats.indexedPages >= SMALL_CORPUS_THRESHOLD;
  if (useRelativeFloor && top1 < stats!.p30!) {
    return {
      provenance: results.slice(0, 3).map((r) => ({ wikiPage: `wiki/${r.path}` })),
      confidence: "absent",
      basis: "unsupported",
      abstain: true,
      rationale:
        `Top match score ${top1.toFixed(2)} is below the corpus 30th percentile ` +
        `(${stats!.p30!.toFixed(2)}). Likely a poor match.`,
    };
  }

  const top2 = results[1]?.score ?? 0;
  const ratio = top2 > 0 ? top1 / top2 : Infinity;
  const confidence: EvidenceConfidence = ratio >= TOP1_OVER_TOP2_STRONG ? "strong" : "weak";

  const rationale =
    confidence === "strong"
      ? `Top match clearly dominates (${top1.toFixed(2)} vs ${top2.toFixed(2)}).`
      : `Top matches are close in score (${top1.toFixed(2)} vs ${top2.toFixed(2)}); ` +
        `multiple plausible answers — read several before relying on the top result.`;

  return {
    provenance: results.slice(0, 3).map((r) => ({ wikiPage: `wiki/${r.path}` })),
    confidence,
    basis: "synthesized",
    abstain: false,
    rationale,
  };
}

/**
 * For wiki_search_read: take the search envelope and downgrade if the page
 * the agent is about to read shows weak metadata of its own.
 *
 * Rules (per docs/evidence-envelope.md):
 *   - empty `sources: []` AND no `synthesis: true` flag → drop one tier
 *   - `legacyUnsupported: true` (Phase 2a migration marker)  → drop one tier
 *   - last edit > 90 days → no tier change but rationale notes it
 */
export interface ReadPageMetadata {
  sources?: string[];
  synthesis?: boolean;
  legacyUnsupported?: boolean;
  lastEditISO?: string;
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export function downgradeForReadPage(
  envelope: EvidenceEnvelope,
  page: ReadPageMetadata,
  now: Date = new Date(),
): EvidenceEnvelope {
  let confidence = envelope.confidence;
  const reasons: string[] = [];

  const grounded = (page.sources?.length ?? 0) > 0;
  if (!grounded && !page.synthesis) {
    confidence = stepDown(confidence);
    reasons.push("page has no sources and no synthesis flag");
  }
  if (page.legacyUnsupported) {
    confidence = stepDown(confidence);
    reasons.push("page is flagged legacyUnsupported");
  }

  let staleNote = "";
  if (page.lastEditISO) {
    const ageMs = now.getTime() - new Date(page.lastEditISO).getTime();
    if (ageMs > NINETY_DAYS_MS) {
      const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      staleNote = ` Page last edited ${days} days ago.`;
    }
  }

  if (confidence === envelope.confidence && !staleNote) {
    return envelope; // no change
  }

  return {
    ...envelope,
    confidence,
    abstain: confidence === "absent" ? true : envelope.abstain,
    rationale:
      reasons.length > 0
        ? `${envelope.rationale} Downgraded: ${reasons.join("; ")}.${staleNote}`
        : `${envelope.rationale}${staleNote}`,
  };
}

function stepDown(c: EvidenceConfidence): EvidenceConfidence {
  if (c === "strong") return "weak";
  if (c === "weak") return "absent";
  return "absent";
}

/**
 * Compute the corpus's search-distribution stats by sampling page titles as
 * queries. Cheap proxy for "what does a typical user search look like" —
 * gives the percentile cutoff that buildSearchEnvelope uses.
 *
 * Below SMALL_CORPUS_THRESHOLD pages, the percentile is too noisy; return
 * `p30: null` and let buildSearchEnvelope fall back to the absolute floor.
 */
export function computeSearchDistribution(
  pageTitles: string[],
  runQuery: (q: string) => { score: number }[],
): CorpusSearchStats {
  const indexedPages = pageTitles.length;
  if (indexedPages < SMALL_CORPUS_THRESHOLD) {
    return {
      p30: null,
      indexedPages,
      computedAt: new Date().toISOString(),
    };
  }

  // Sample up to 50 titles for percentile computation. On very large corpora
  // we don't need all titles — 50 evenly-spaced gives a stable estimate.
  const step = Math.max(1, Math.floor(indexedPages / 50));
  const top1Scores: number[] = [];
  for (let i = 0; i < indexedPages; i += step) {
    const title = pageTitles[i]!;
    if (!title.trim()) continue;
    const hits = runQuery(title);
    if (hits.length > 0) top1Scores.push(hits[0]!.score);
  }

  if (top1Scores.length === 0) {
    return {
      p30: null,
      indexedPages,
      computedAt: new Date().toISOString(),
    };
  }

  top1Scores.sort((a, b) => a - b);
  const idx = Math.floor(top1Scores.length * 0.3);
  return {
    p30: top1Scores[idx]!,
    indexedPages,
    computedAt: new Date().toISOString(),
  };
}
