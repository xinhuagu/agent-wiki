# Evidence Envelope

**Status: Phases 1–4 delivered. Phase 2b (hard reject) ships disabled and is operator-toggleable via `AGENT_WIKI_EVIDENCE_REJECT_UNSUPPORTED` once the would-reject ratio settles. Section "Phase 0 — design" below is preserved as the original contract; downstream sections describe what shipped.**

agent-wiki has accumulated many evidence-like features (raw provenance, frontmatter `sources`, COBOL lineage confidence tiers, graph edge evidence, lint, `raw_coverage`), but each tool exposes them differently. Agents using one tool's output have no reliable way to ask "is this match strong enough to act on?" The envelope is a unified contract every retrieval / query tool will adopt across the evidence-first program (#78).

This document fixes the contract and the migration plan. Phase 0 specifies; Phases 1–4 implement.

## The shape

```ts
export interface EvidenceEnvelope {
  /**
   * Pointers back to the underlying source(s). Empty array means the
   * basis is "synthesized" or "unsupported" — there is no source to cite.
   */
  provenance: Array<{
    raw?: string;       // path under raw/  (e.g., "raw/PAYROLL.cbl")
    wikiPage?: string;  // path under wiki/ (e.g., "wiki/cobol/PAYROLL.md")
    line?: number;      // 1-based line number when applicable
  }>;

  /**
   * Coarse confidence the consumer can branch on without parsing details.
   * - "strong":  back this with action
   * - "weak":    surface but verify before action
   * - "absent":  do not rely on this without seeking other evidence
   */
  confidence: "strong" | "weak" | "absent";

  /**
   * What kind of evidence backs this result.
   * - "deterministic": parsed from raw source; round-trippable
   * - "inferred":      pattern / structural inference, not a direct quote
   * - "synthesized":   compiled / aggregated from multiple sources
   * - "unsupported":   no evidence beyond agent assertion
   */
  basis: "deterministic" | "inferred" | "synthesized" | "unsupported";

  /**
   * Recommendation: caller should not rely on this without further
   * verification. Consumers should treat `abstain: true` like a
   * "no answer above threshold" signal and not paper over it.
   */
  abstain: boolean;

  /**
   * Human-readable explanation of the values above. Surfaced in wiki
   * renders and tool responses. Keep short (one sentence ideal).
   */
  rationale: string;
}
```

The shape is **purely additive**. Tools that don't yet emit envelopes are unchanged. Tools that adopt it return `evidence: EvidenceEnvelope` alongside their existing fields.

## Confidence derivation by access path (Caveat 5)

The envelope's `confidence` field has **the same semantics** across tools, but the inputs that drive it differ. Phase 1+ implementations follow this table.

| Path                               | Confidence source                                                                  |
|------------------------------------|------------------------------------------------------------------------------------|
| `wiki_search` match list           | BM25 score relative to corpus distribution + absolute floor (Caveat 2)             |
| `wiki_search_read` (search-and-read) | inherits the search match's confidence, downgraded if the page itself has weak metadata (no sources, stale) |
| `wiki_read("explicit/path.md")`    | only the page's own metadata (sources count, `synthesis` flag, last edit time)     |
| `code_query field_lineage`         | maps from the lineage entry's tier (Caveat 3)                                      |
| `code_query impact`                | per-edge: `deterministic` from graph evidence; lower-confidence-path → weak        |
| `code_query trace_variable`        | strong when the variable resolves; weak when only loose name match                 |

## Lineage-tier ↔ envelope mapping (Caveat 3)

The envelope is **strictly language-agnostic**. `src/evidence.ts` only declares the envelope shape and primitive types. **Each plugin owns its own domain-tier-to-envelope mapping** under `src/<plugin>/`. The core module never imports plugin types.

When a future plugin (Java, Python, etc.) joins, it adds:

1. Its own tier type union under `src/<plugin>/`
2. Its own mapping function (e.g., `javaTierToEvidence`)
3. Its own test file pinning the mapping
4. A short addendum to this section of the doc

The COBOL mapping below is the **reference example** other plugins follow.

### COBOL reference mapping

COBOL lineage builders emit five domain-level tiers. The envelope's coarser `confidence`/`basis` fields are **derived** from the tier — the tier is the authoritative semantic label and stays in the JSON artifact alongside the envelope.

Implementation: `src/cobol/evidence-mapping.ts` (`cobolTierToEvidence`).

| Lineage tier (existing)    | Envelope `confidence` | Envelope `basis` |
|----------------------------|-----------------------|------------------|
| `deterministic`            | `strong`              | `deterministic`  |
| `high`                     | `weak`                | `inferred`       |
| `ambiguous`                | `absent`              | `inferred`       |
| `inferredHighConfidence`   | `weak`                | `inferred`       |
| `inferredAmbiguous`        | `absent`              | `inferred`       |

This is one-way: the envelope is computed from the tier; the tier is not reconstructed from the envelope. Future COBOL lineage families (e.g., dataset-mediated, column-level DB2) extend the tier table; the envelope mapping is mechanical.

## Abstain rule (Caveat 2)

For `wiki_search`, the abstain decision uses an absolute floor on the top1 BM25 score. If `top1 < 2.0`, the envelope sets `abstain: true`, `confidence: "absent"`, and clears `provenance` so callers do not treat the weak hits as supporting evidence.

The original design also called for a relative cutoff — BM25 score below the corpus 30th percentile — recomputed during `wiki_admin rebuild`. That part was dropped during Phase 1 implementation: any cold-start sampling we could plausibly do (page titles as queries) measures best-case retrieval, not typical-query strength, and over-flags real queries as abstain. A real percentile cutoff requires actual user query logs; until those exist, the absolute floor is the only honest signal.

Phase 1 confidence derivations:

- top1 score `≥ 2 ×` top2 score → `confidence: "strong"` (clear winner)
- top1 within `2 ×` top2 score → `confidence: "weak"` (multiple plausible matches; consumer should read several)
- top1 below absolute floor (`< 2.0`) → `confidence: "absent"`, `abstain: true`
- 0 results → existing `knowledge_gap` response, plus envelope with `abstain: true`, `basis: "unsupported"`

The 2.0 floor was calibrated by inspection on the bundled fixtures; revisit when corpus characteristics change. If `wiki_admin` ever starts logging real queries (Phase 4 dashboard candidate), a percentile cutoff can be reintroduced — informed by typical-query data rather than self-search noise.

## Unsupported-write telemetry (Caveat 1)

Phase 2a surfaces "this page has no sources" without rejecting the write. To make Phase 2b's hard-rejection threshold data-driven rather than guessed, 2a must record:

```ts
interface UnsupportedWriteEvent {
  page: string;            // e.g., "concept-foo.md"
  timestamp: string;       // ISO 8601
  agentHint?: string;      // tool caller identity if available
  hadSynthesisFlag: boolean;  // did the writer set synthesis: true?
  rawSourcesCount: number;    // sources[] length
}
```

**Storage**: append-only JSONL at `.agent-wiki/evidence-write-log.jsonl` (already-ignored `.agent-wiki/` namespace). Rotation policy: cap at 10 MB / 30 days, whichever first; `wiki_admin lint` truncates.

The unsupported log only captures the **numerator** — distinct unsupported transitions and rejected attempts. To put that count in context, a sibling **per-write counter** at `.agent-wiki/evidence-write-counter.jsonl` records every classified write attempt:

```ts
interface WriteEvent {
  timestamp: string;            // ISO 8601
  kind: "grounded" | "synthesis" | "unsupported" | "rejected" | "legacy";
}
```

Same rotation policy. The counter ticks on every classified `wiki_write` (system pages and bypassed writes excluded), regardless of whether the unsupported log dedupes the event. This keeps the "denominator" honest: `(unsupportedWrites + rejectedWrites) / totalWrites` reflects how often unsupported attempts occur versus total write volume — see `wouldRejectRatio` below.

**Aggregation**: Phase 4 (`wiki_admin action: "evidence-report"`, see below) reads both logs and renders the corpus-level report. `wiki_admin rebuild` continues to emit a one-line summary into `wiki/log.md` ("last 7 days: 12 unsupported + 0 rejected / 47 wiki_write(s) (5 new unsupported pages) — 25.5% blocked-or-would-block under Phase 2b") so operators see the headline ratio without running the full report. Three numerators are surfaced because they answer different questions:

- **`unsupportedWrites`** — every write that ended up unsupported in warn mode, including re-edits.
- **`rejectedWrites`** — every write blocked under Phase 2b reject mode.
- **`unsupportedTransitions`** — distinct *new* unsupported pages introduced (deduped on transition; lower bound, useful for authoring-intent vs. churn).

The headline ratio is `(unsupportedWrites + rejectedWrites) / totalWrites` — **mode-invariant**: in warn mode, `rejectedWrites` is 0 and the ratio is what 2b would block; in reject mode, `unsupportedWrites` is 0 (those writes go through the reject path instead) and the ratio is what 2b is currently blocking. Either way the same number drives threshold decisions.

The ratio is omitted when the counter file is empty (early deployments would otherwise read as 0%).

Without this hook in Phase 2a, Phase 2b is guesswork. Including it now means the data is collected from day one.

## Corpus-level evidence report (Phase 4)

Phase 4 ships as `wiki_admin action: "evidence-report"`. The handler calls `buildEvidenceReport` (`src/evidence-report.ts`) which aggregates the four telemetry sources earlier phases populate into a single `EvidenceReport` and renders it to Markdown. Pass `write: true` to also persist the rendered report to `wiki/evidence-report.md` (a system page, so the regeneration does not tick the write counter).

```bash
agent-wiki call wiki_admin '{"action":"evidence-report"}'
agent-wiki call wiki_admin '{"action":"evidence-report","write":true}'
```

The response carries the structured `report` (typed `EvidenceReport`) alongside the rendered `markdown`. The four sections, in order:

### 1. Source coverage

Walks every non-system page under `wiki/`, parses frontmatter, and buckets it. Counts are mutually exclusive — order of classification matters and is fixed:

| Bucket             | Frontmatter signal                                                |
|--------------------|-------------------------------------------------------------------|
| `synthesis`        | `synthesis: true` **or** `type: synthesis`                        |
| `grounded`         | non-empty `sources: [...]`                                        |
| `unsupported`      | `unsupported: true` (Phase 2a stamp)                              |
| `legacyUnsupported`| `legacyUnsupported: true` (grandfather flag from migration)       |
| `other`            | none of the above — classifier was bypassed; investigate          |

Pages with both `sources` and `synthesis: true` count as `synthesis` (a synthesis page that cites supports is still a synthesis page). Malformed frontmatter counts as `other` rather than crashing the report.

### 2. Search trust

Reads `.agent-wiki/evidence-search-log.jsonl` (rotated to 30 days). Per `SearchEvent`:

- `totalSearches` and `abstainCount` (events whose `abstainReason !== null`)
- `abstainRatio` = `abstainCount / totalSearches`, or `null` when no events
- `medianTop1Score` — median BM25 score of the top match across the window
- `ratioHistogram` — `top1/top2` distribution bucketed at the strong/weak boundary: `< 1.5`, `1.5–2.0`, `2.0–3.0`, `≥ 3.0`. Single-result matches (no `top2`) are excluded; they have no comparator.

The 2.0 abstain floor described above still drives the per-call decision; this section just exposes corpus-wide drift.

### 3. Lineage diagnostic surfacing

Reads `raw/parsed/cobol/field-lineage.json` if present and pulls diagnostics from three surfaces — two cross-program lineage families plus a top-level input-quality surface:

- **`fieldLineage`** — top-level `summary.diagnosticsByKind`, flagging input models the lineage builder couldn't use (e.g. `parsed-zero-data-items` from listing-extracted copybooks whose headers escaped the col-7 comment filter). Suppressed when `totalDiagnostics === 0`.
- **`callBound`** — caller `USING` ↔ callee `LINKAGE` flow. Surfaces `callSites`, `pairs`, and the per-kind diagnostic counts the lineage builder emitted (e.g., unresolved callee, ambiguous parameter binding).
- **`db2`** — writer→reader flow via shared DB2 tables. Surfaces `sharedTables`, `pairs`, and per-kind diagnostic counts.

The exact diagnostic kinds are owned by the COBOL plugin's lineage builder and may grow over time; the report surfaces whatever kinds are present in the artifact so a new diagnostic surface does not require updating the report code. Other plugins (when they add their own field-lineage artifacts) follow the same shape.

### 4. Trend (last 4 weeks)

Reads `.agent-wiki/evidence-write-counter.jsonl` and buckets events into the four most recent weekly windows aligned to `now`. Each `TrendBucket` carries:

- `weekStart` — ISO date (YYYY-MM-DD) of the bucket's start
- `totalWrites` — every classified write in the bucket
- `unsupportedOrRejected` — `kind === "unsupported" || kind === "rejected"` only

Counter-only by design: the unsupported log dedupes transitions and would produce misleading "5 unsupported / 0 writes" rows for early weeks. Pre-counter weeks display 0/0; this self-resolves within four weeks of running upgraded code.

The rendered Markdown also draws unicode sparklines over the four buckets so the trend is readable at a glance without parsing the table.

## Synthesis-page grandfather migration (Caveat 4)

Day-1 of Phase 2a, every existing compiler-generated wiki page (`wiki/cobol/system-map.md`, `field-lineage.md`, `call-graph.md`, etc.) would register as "unsupported" — flooding the signal with false positives. Migration is run **once** during the first `wiki_admin rebuild` after Phase 2a deploys.

Classification rules, in order:

1. **Frontmatter `type: synthesis`** present → already legitimate, no change.
2. **Path matches `wiki/<plugin-id>/...`** AND filename matches a known compiler artifact (`system-map.md`, `call-graph.md`, `field-lineage.md`, plus per-program `<stem>.md` and per-copybook `<stem>.md`) → add `synthesis: true` automatically; do not flag.
3. **Page has non-empty `sources: [...]`** → grounded, no change.
4. **Pre-existing user-authored page with empty sources, no synthesis flag** → grandfather: add `legacyUnsupported: true` to frontmatter and lint warning, but do not block. New writes after migration day must use the explicit `synthesis: true` route.
5. **Anything created after migration day with empty sources and no synthesis flag** → Phase 2a soft-warn, Phase 2b reject.

This keeps the "unsupported" signal meaningful while not penalizing existing legitimate synthesis or punishing pre-Phase 2a authoring.

## Adoption sequence

This document defines the contract for the entire program. Implementation phases adopt it incrementally:

| Phase | Implementer | Adopts envelope on        |
|-------|-------------|---------------------------|
| 1     | search      | `wiki_search`, `wiki_search_read` |
| 2a    | write       | wiki_write side-channel telemetry |
| 3     | lineage     | `field_lineage`, `impact`, `trace_variable` responses; lineage builder diagnostic surfaces |
| 2b    | write       | wiki_write hard rejection (informed by 2a telemetry) |
| 4     | dashboard   | `wiki_admin` evidence report aggregating all of the above |

Phase 0 itself ships only:
- This document
- `EvidenceEnvelope` TypeScript interface
- No tool changes, no consumers

## Open questions deferred to later phases

- **Hybrid search vector ranking**: when BM25 + vector blend produce a result, the envelope's confidence should probably reflect the blended score, not BM25 alone. Phase 1 decides.
- **Multi-source pages**: a wiki page citing 5 raw sources isn't 5× more credible than one citing 1. Confidence should saturate, not multiply. Phase 2a chooses the curve.
- **Cross-language consistency**: when future plugins (Java, Python) join, their lineage tiers may not map cleanly to the COBOL table. Each plugin documents and implements its own mapping under `src/<plugin>/`, sharing only the envelope shape from `src/evidence.ts`. The COBOL plugin's `evidence-mapping.ts` is the reference template.
- **User-facing explanations**: `rationale` is the only freeform field. Phase 4 ships with structured aggregates in the corpus report rather than per-envelope `evidenceFactors`; the per-envelope rationale stays a single sentence.
- **Search percentile cutoff**: Phase 4's `evidence-search-log.jsonl` collects the data needed to reintroduce the corpus-percentile abstain cutoff dropped in Phase 1. Decide once the log has accumulated meaningful query history.

## See also

- [`product-direction.md`](product-direction.md) — priority #1 ("retrieval trust signals") this program addresses
- [`legacy-code-knowledge-compiler-prd.md`](legacy-code-knowledge-compiler-prd.md) — Functional Requirements Phase 3 / 4 establish the lineage tiering this envelope wraps
- [`code-analysis-plugins.md`](code-analysis-plugins.md) — `buildDerivedArtifacts` produces the lineage entries Phase 3 will wrap in envelopes
