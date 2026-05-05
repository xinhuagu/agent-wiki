/**
 * COBOL plugin's mapping from its lineage confidence tiers to the
 * language-agnostic EvidenceEnvelope contract (Phase 0 of #78).
 *
 * Each plugin owns its own mapping — the core `src/evidence.ts` module
 * stays language-agnostic and never imports plugin types. When Phase 3
 * starts wrapping lineage entries in envelopes, it imports `cobolTierToEvidence`
 * from here.
 *
 * The tier itself remains the authoritative semantic label in lineage JSON
 * artifacts alongside the derived envelope; this mapping is one-way.
 *
 * See docs/evidence-envelope.md ("Lineage-tier ↔ envelope mapping").
 */

import type { EvidenceBasis, EvidenceConfidence } from "../evidence.js";

/**
 * Confidence tiers used by COBOL lineage builders:
 *   - call-boundary-lineage.ts emits `deterministic` and `high`.
 *   - field-lineage.ts emits `deterministic`, `inferredHighConfidence`,
 *     and `inferredAmbiguous`.
 *   - db2-table-lineage.ts emits `deterministic`.
 *   - `ambiguous` is reserved for future use (call-bound shape mismatches
 *     that should be surfaced rather than silently excluded; tracked under
 *     evidence-first Phase 3 lineage diagnostics).
 */
export type CobolLineageTier =
  | "deterministic"
  | "high"
  | "ambiguous"
  | "inferredHighConfidence"
  | "inferredAmbiguous";

export function cobolTierToEvidence(
  tier: CobolLineageTier,
): { confidence: EvidenceConfidence; basis: EvidenceBasis } {
  switch (tier) {
    case "deterministic":
      return { confidence: "strong", basis: "deterministic" };
    case "high":
    case "inferredHighConfidence":
      return { confidence: "weak", basis: "inferred" };
    case "ambiguous":
    case "inferredAmbiguous":
      return { confidence: "absent", basis: "inferred" };
  }
}
