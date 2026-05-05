/**
 * EvidenceEnvelope — unified evidence contract for retrieval / query tools.
 *
 * Phase 0 of the evidence-first program (#78): interface only, no consumers
 * yet. Phase 1+ adopts incrementally per the adoption sequence in
 * docs/evidence-envelope.md.
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
