/**
 * EvidenceEnvelope — unified evidence contract for retrieval / query tools.
 *
 * Originally introduced as Phase 0 of the evidence-first program (#78);
 * Phases 1–4 have shipped with consumers across `wiki_search`,
 * `wiki_search_read`, `code_*`, and `raw_read` / `raw_coverage`. See
 * docs/evidence-envelope.md for the contract and adoption history.
 *
 * Strictly language-agnostic. Each plugin owns its own domain-tier-to-envelope
 * mapping under its own `src/<plugin>/` directory. The core module never
 * imports plugin types and never lists them — neither in code nor in comments.
 *
 * The envelope is purely additive on tool responses. Consumers branch on
 * `confidence` and `abstain` without parsing tool-specific evidence detail.
 */

export type EvidenceConfidence = "strong" | "weak" | "absent";

export type EvidenceBasis =
  | "deterministic"
  | "inferred"
  | "synthesized"
  | "unsupported";

export interface EvidenceProvenance {
  /** Path under raw/. */
  raw?: string;
  /** Path under wiki/. */
  wikiPage?: string;
  /** 1-based line number when applicable. */
  line?: number;
}

export interface EvidenceEnvelope {
  provenance: EvidenceProvenance[];
  confidence: EvidenceConfidence;
  basis: EvidenceBasis;
  abstain: boolean;
  rationale: string;
}

/**
 * Factory for the most common envelope shape: a successful round-trippable
 * read or query backed by a parsed source. Strong + deterministic + not
 * abstaining. Use when the result was derived directly from raw/ content
 * with no inference layer.
 */
export function strongDeterministic(
  rationale: string,
  provenance: EvidenceProvenance[] = [],
): EvidenceEnvelope {
  return {
    confidence: "strong",
    basis: "deterministic",
    abstain: false,
    rationale,
    provenance,
  };
}

/**
 * Factory for the negative counterpart: the query was deterministic (we
 * looked at the parsed source / corpus state) and found nothing. Absent +
 * abstain so callers don't act on a vacuous response.
 */
export function absentDeterministic(
  rationale: string,
  provenance: EvidenceProvenance[] = [],
): EvidenceEnvelope {
  return {
    confidence: "absent",
    basis: "deterministic",
    abstain: true,
    rationale,
    provenance,
  };
}
