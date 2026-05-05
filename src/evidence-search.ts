/**
 * Evidence-first phase 1: derive an EvidenceEnvelope from a search result
 * list so wiki_search and wiki_search_read can signal "weak / abstain"
 * instead of treating every BM25 hit as authoritative.
 *
 * See docs/evidence-envelope.md.
 *
 * Confidence rules:
 *   - 0 results                                      → absent + abstain
 *   - top1 below absolute floor (BM25 < 2.0)         → absent + abstain
 *   - top1 ≥ 2× top2                                 → strong
 *   - top1 < 2× top2                                 → weak
 *
 * The original design also had a corpus 30th-percentile cutoff. That was
 * dropped because the percentile would have to come from real query logs
 * to be meaningful — sampling page titles as queries (the only feasible
 * cold-start source) produces a best-case score distribution, not a
 * typical-query one, and so over-flags real queries as abstain. The
 * absolute floor catches the obvious-junk case; relative-confidence
 * signaling lives in the top1/top2 ratio rule.
 */

import type { SearchResult } from "./search.js";
import type { EvidenceEnvelope, EvidenceConfidence } from "./evidence.js";

/** Absolute floor below which any top1 BM25 score is "weak in absolute terms". */
export const ABSOLUTE_FLOOR = 2.0;

/** top1/top2 ratio that splits "strong" from "weak". */
const TOP1_OVER_TOP2_STRONG = 2.0;

/** Provenance fan-out — top N pages cited in the envelope on a non-abstain match. */
const PROVENANCE_LIMIT = 3;

export function buildSearchEnvelope(
  results: SearchResult[],
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
    // Abstain: provenance stays empty so callers can't accidentally treat
    // the weak hits as supporting evidence. Mention the top hits in the
    // rationale so a debugger can still see what the engine returned.
    const sample = results.slice(0, PROVENANCE_LIMIT).map((r) => r.path).join(", ");
    return {
      provenance: [],
      confidence: "absent",
      basis: "unsupported",
      abstain: true,
      rationale:
        `Top match score ${top1.toFixed(2)} is below the absolute floor (${ABSOLUTE_FLOOR}). ` +
        `Treat as no usable result. Engine returned weak hits: ${sample}.`,
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
    provenance: results.slice(0, PROVENANCE_LIMIT).map((r) => ({ wikiPage: `wiki/${r.path}` })),
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
    if (Number.isFinite(ageMs) && ageMs > NINETY_DAYS_MS) {
      const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      staleNote = ` Page last edited ${days} days ago.`;
    }
  }

  if (confidence === envelope.confidence && !staleNote) {
    return envelope; // no change
  }

  // If the downgrade landed at "absent", clear provenance so downstream
  // code doesn't treat the weak hits as supporting evidence.
  const provenance = confidence === "absent" ? [] : envelope.provenance;

  return {
    ...envelope,
    provenance,
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
