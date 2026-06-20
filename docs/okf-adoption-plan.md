# OKF Adoption Plan

This document evaluates whether `agent-wiki` can adopt the Open Knowledge
Format (OKF) direction described in
[`open-knowledge-format.md`](open-knowledge-format.md), based on the current
codebase and documentation.

## Executive Conclusion

Adopting OKF is feasible and strategically coherent.

`agent-wiki` already has most of the hard primitives an OKF package needs:

- immutable raw sources with SHA-256 sidecars
- mutable Markdown wiki pages with parseable frontmatter
- source coverage reporting
- evidence envelopes on retrieval and code-query paths
- unsupported-write telemetry and evidence reports
- deterministic rebuild and lint operations
- Git-native files rather than a required hosted service

The missing work is mostly format hardening: a portable manifest, a JSON Schema,
conformance checks, export/import tests, and a clear compatibility promise.

The recommended direction is:

> make `agent-wiki` the reference implementation of a Git-native OKF package
> format for agent-maintained knowledge

That means OKF should become a public contract around the existing architecture,
not a rewrite of the product.

## External Reference Findings

### Open Definition / Open Knowledge Foundation

The Open Definition frames open knowledge around access, use, modification,
sharing, provenance, machine readability, and open formats.

Useful requirements for `agent-wiki`:

- OKF packages must be readable as ordinary files.
- The package must declare license and provenance policy.
- Format rules must be machine-checkable, not only prose.
- Knowledge should remain modifiable and reviewable.
- No hosted service should be required to inspect or move a package.

Boundary:

- `agent-wiki` should not claim that OKF is an official Open Knowledge
  Foundation standard.
- Private enterprise knowledge can still use the format; the format should make
  license and access policy explicit rather than require all content to be open.

### Google Data Commons

Data Commons shows the value of common schemas and interoperable knowledge graph
instances. Its center of gravity is public data: standard schemas, APIs, and a
graph that can join data across sources.

Useful requirements for `agent-wiki`:

- Package schemas should be explicit and reusable.
- Derived graph/index artifacts should be rebuildable and queryable.
- Interoperability should not depend on one central host.

Boundary:

- `agent-wiki` is not a Data Commons replacement.
- OKF should not require RDF, SPARQL, or a cloud API.
- OKF is a repository package format for operational knowledge, not a public
  statistics graph.

### LLM-Wiki Research

LLM-Wiki argues that agent retrieval should behave less like one-shot lookup and
more like reasoning: search, read, traverse links, judge evidence sufficiency,
and repair structural errors over time.

Useful requirements for `agent-wiki`:

- Search and read should be first-class agent operations.
- Links and page structure are part of retrieval quality, not decoration.
- Agents need explicit abstain / weak-evidence signals.
- Self-improvement should be mediated by persistent logs and reviewable edits.

Boundary:

- OKF should define portable package structure and governance; it should not
  require one specific retrieval algorithm.
- Vector indexes should be optional generated artifacts, not the source of truth.

## Current Codebase Inventory

### Raw Layer

Current state:

- `raw_ingest` supports content, local files/directories, URL fetch, Confluence,
  and Jira.
- Raw files are immutable by convention and carry `.meta.yaml` sidecars.
- Metadata includes SHA-256, source URL, description, tags, and timestamps.
- `raw_read`, `raw_list`, `raw_versions`, and `raw_coverage` expose the layer.
- `wiki_admin action: "lint"` verifies raw integrity.

OKF fit:

- Strong. This maps directly to OKF `raw/`.
- The sidecar metadata is already close to an OKF source manifest.

Gaps:

- The format does not yet define a canonical package-level inventory of raw
  files and hashes.
- Raw metadata schema is implicit in TypeScript and tests, not published as an
  OKF schema.

### Wiki Layer

Current state:

- Wiki pages are Markdown files under `wiki/`.
- Frontmatter supports `title`, `type`, `tags`, `sources`, timestamps, and
  synthesis markers.
- `wiki_write` manages timestamps, classification, auto-routing, and auto-linking.
- `wiki_read`, `wiki_search`, `wiki_list`, and `wiki_delete` expose the layer.
- System pages include `index.md`, `timeline.md`, `log.md`, nested `index.md`,
  and `evidence-report.md`.

OKF fit:

- Strong. This maps directly to OKF `wiki/`.
- Existing frontmatter can carry page class, source links, freshness, and
  synthesis state.

Gaps:

- Page class is distributed across `type`, `sources`, `synthesis`,
  `unsupported`, and `legacyUnsupported`; OKF needs a documented classifier.
- There is no OKF schema for allowed frontmatter fields.
- Staleness policy is lint-oriented, but not part of a package manifest yet.

### Evidence Layer

Current state:

- `EvidenceEnvelope` is implemented as a language-agnostic contract.
- Retrieval and code-query paths return `confidence`, `basis`, `abstain`,
  `rationale`, and provenance.
- `wiki_write` classifies writes as grounded, synthesis, unsupported, rejected,
  or legacy.
- `.agent-wiki/evidence-write-log.jsonl`,
  `.agent-wiki/evidence-write-counter.jsonl`, and
  `.agent-wiki/evidence-search-log.jsonl` drive evidence reporting.
- `wiki_admin action: "evidence-report"` renders a corpus-level report.

OKF fit:

- Strong. This is a differentiator versus generic Markdown wiki formats.

Gaps:

- Evidence logs currently live in an operational `.agent-wiki/` namespace, not
  a portable `evidence/` package namespace.
- Some logs may be private telemetry. OKF needs to distinguish portable evidence
  artifacts from local operational logs.
- Claim-level provenance is not yet a stable exported index.

### Indexes And Search

Current state:

- Local BM25 search is built into `wiki_search`.
- Optional hybrid vector reranking is enabled by `.agent-wiki.yaml`.
- Vector cache lives in `wiki/.search-vectors.json`.
- Directory indexes and timeline pages are generated by rebuild/write/delete.
- The graph viewer reads Markdown pages and wikilinks.

OKF fit:

- Good. Generated indexes can be part of a package but should be rebuildable.

Gaps:

- OKF should define which index artifacts are canonical and which are cache.
- `wiki/.search-vectors.json` is an implementation cache; it should not be a
  required part of the portable format.
- There is no package-level graph snapshot contract yet.

### Admin And Configuration

Current state:

- `.agent-wiki.yaml` is the runtime configuration file.
- It stores workspace paths, security boundaries, lint options, search config,
  evidence config, Atlassian config, auto-link behavior, and COBOL settings.
- `.agent-wiki.local.yaml` supports local overrides.
- `wiki_admin` currently supports `init`, `config`, `rebuild`, `lint`, and
  `evidence-report`.

OKF fit:

- Good, but this is where the biggest design decision lives.

Decision:

- Keep `.agent-wiki.yaml` as runtime/operator config.
- Add `agent-wiki.yaml` as the portable OKF package manifest.

Reason:

- Runtime config can include machine-local paths, security allowlists, tokens via
  env references, and deployment-specific settings.
- Package manifests should be safe to commit, copy, publish, and validate.

### Language Compiler Layer

Current state:

- `code_parse` and `code_query` expose deterministic code analysis.
- COBOL is shipped with AST extraction, normalized models, call graphs, DB2 flow,
  CALL boundary flow, and field lineage.
- Parsed artifacts live under `raw/parsed/cobol/`.
- Generated wiki pages are written back into `wiki/`.
- Precision/recall evaluation fixtures exist for lineage.

OKF fit:

- Strong. This is a high-value OKF use case because code knowledge needs
  deterministic provenance, lineage evidence, and reproducible generated pages.

Gaps:

- `raw/parsed/` is currently both a derived artifact area and a subdirectory of
  raw. OKF should explicitly mark it as generated, not primary source evidence.
- Compiler artifact schemas are not yet package-level schemas.

### Distribution And CI

Current state:

- The npm package ships `dist`, `skills`, `.claude-plugin`, `docs`,
  `architecture.svg`, and graph viewer files.
- CI and release workflows exist.
- Tests cover wiki operations, evidence reports, search, raw coverage, COBOL
  parsing, and graph behavior.

OKF fit:

- Good. The codebase is already test-oriented enough to add conformance tests.

Gaps:

- There is no OKF conformance test suite.
- There is no committed example OKF package fixture.
- `package.json` includes `schemas` in `files`, but the source tree does not yet
  expose an OKF schema directory as a public contract.

## Feasibility Assessment

### High-Confidence Areas

- **Package layout**: current `raw/`, `wiki/`, and `schemas/` concepts already
  match the OKF structure.
- **Machine readability**: YAML frontmatter and YAML config are already parsed.
- **Evidence model**: the evidence envelope gives OKF a real trust contract.
- **Git-native behavior**: files are diffable, reviewable, and revertable.
- **No hosted dependency**: core operations work locally without an LLM API.

### Medium-Complexity Areas

- **Manifest design**: easy to add, but must avoid overlap with runtime config.
- **Schema publication**: straightforward, but needs stable names and versioning.
- **Format checks**: existing lint can be extended, but OKF should have explicit
  pass/fail semantics.
- **Export/import**: likely feasible, but must handle caches, local logs, and
  generated artifacts cleanly.

### Risk Areas

- **Name ambiguity**: OKF can be confused with Open Knowledge Foundation. Use
  "Open Knowledge Format" carefully and clarify that it is an `agent-wiki`
  package format.
- **Private data licensing**: enterprise packages may not be open content. OKF
  should require explicit license/access metadata, not public release.
- **Frontmatter drift**: agents can invent fields unless schema/lint catches
  them.
- **Generated artifact stability**: OKF conformance should not fail just because
  rebuildable cache files are absent.
- **Telemetry privacy**: raw operational logs may contain sensitive prompts,
  search terms, or internal page names. OKF must support redacted summaries.
- **Version promise**: once external users depend on the format, breaking changes
  need migration rules.

Overall feasibility: **high**, if the first release is scoped to OKF v0.1 and
keeps runtime behavior backward compatible.

## Target OKF v0.1 Contract

### Package Manifest

Add a committed `agent-wiki.yaml` manifest at the package root.

Example:

```yaml
format: agent-wiki-okf
format_version: 0.1
name: payroll-modernization-knowledge
version: 0.1.0
license: internal-proprietary
owner: platform-modernization
created_at: 2026-06-20
generator:
  name: agent-wiki
  version: 0.22.4
source_policy:
  raw_immutable: true
  require_sha256: true
wiki_policy:
  require_sources_for_grounded_pages: true
  allow_synthesis_pages: true
evidence_policy:
  allow_unsupported_pages: warn
  require_abstain_signal: true
```

### Runtime Config Separation

Keep `.agent-wiki.yaml` for runtime configuration:

- workspace location
- security allowlists
- local import settings
- search weights
- evidence hard-reject switch
- site-specific COBOL settings

Do not require `.agent-wiki.yaml` for a read-only OKF package inspection.

### Logical Package Layers

OKF v0.1 should define these logical layers:

```text
agent-wiki-package/
  agent-wiki.yaml
  raw/
  wiki/
  schemas/
  evidence/
  indexes/
  logs/
```

Mapping to current implementation:

| OKF layer | Current implementation | v0.1 posture |
|-----------|------------------------|--------------|
| `agent-wiki.yaml` | not implemented | add |
| `raw/` | implemented | required |
| `wiki/` | implemented | required |
| `schemas/` | concept exists | optional until schema pack ships |
| `evidence/` | partial via envelopes, reports, `.agent-wiki/` logs | add exported summary artifacts |
| `indexes/` | generated pages, BM25/vector cache | optional generated artifacts |
| `logs/` | `.agent-wiki/*.jsonl` | local by default, export redacted summaries only |

### Page Classes

OKF v0.1 should standardize the existing classifier:

| Class | Current signal | OKF behavior |
|-------|----------------|--------------|
| `grounded` | non-empty `sources` | reliable if sources verify |
| `synthesis` | `synthesis: true` or `type: synthesis` | allowed, must explain derivation |
| `unsupported` | `unsupported: true` | warn or reject by policy |
| `legacyUnsupported` | `legacyUnsupported: true` | grandfathered, must be resolved over time |
| `system` | system page path | excluded from support ratios |
| `stale` | lint freshness rule | warning until page is refreshed |

## Implementation Plan

### Phase 0 - Documentation Alignment

Status: mostly complete.

Deliverables:

- Make README describe OKF as the public format direction.
- Keep `docs/open-knowledge-format.md` as the format thesis.
- Add this adoption plan as the implementation bridge.

Acceptance criteria:

- README tells users why OKF matters in one screen.
- Documentation distinguishes OKF package manifest from runtime config.
- Documentation clearly states what is implemented now versus planned.

### Phase 1 - Manifest And Schema

Goal: make an OKF package detectable and machine-checkable without changing
runtime behavior.

Deliverables:

- Add `schemas/agent-wiki-okf.schema.json`.
- Add `agent-wiki.yaml` manifest support.
- Add a manifest loader that validates:
  - `format`
  - `format_version`
  - `name`
  - `version`
  - `license`
  - `owner`
  - source/wiki/evidence policies
- Add `wiki_admin action: "format-check"`.

Acceptance criteria:

- A valid OKF fixture passes `format-check`.
- Invalid manifest fields fail with actionable errors.
- Existing users without `agent-wiki.yaml` continue to work.
- `wiki_admin action: "lint"` remains backward compatible.

### Phase 2 - Package Inventory And Conformance Report

Goal: turn current evidence and coverage surfaces into a package-level report.

Deliverables:

- Generate a package inventory:
  - raw file count and hash status
  - wiki page count by class
  - schema list
  - generated index/cache list
  - evidence report presence
- Add `okf-report.md` or structured `evidence/okf-report.json`.
- Extend `wiki_admin action: "rebuild"` to optionally refresh OKF metadata.

Acceptance criteria:

- Report can answer: "Is this knowledge package OKF v0.1 conformant?"
- Missing raw metadata, broken sources, unsupported pages, and malformed
  frontmatter are surfaced as explicit findings.
- Generated caches do not become required for conformance.

### Phase 3 - Evidence Export

Goal: separate portable evidence artifacts from local operational telemetry.

Deliverables:

- Add `evidence/source-coverage.json`.
- Add `evidence/page-classes.json`.
- Add `evidence/claim-provenance.json` as a best-effort first pass.
- Keep raw `.agent-wiki/*.jsonl` logs local by default.
- Add an explicit `include_logs` option for advanced exports.

Acceptance criteria:

- A package can be audited without reading private local logs.
- Evidence artifacts are deterministic across rebuilds when inputs are unchanged.
- Unsupported and stale pages are visible without parsing every Markdown file.

### Phase 4 - Export And Import

Goal: make OKF portable across machines, agents, and MCP clients.

Deliverables:

- Add `agent-wiki export --format okf --out <dir-or-zip>`.
- Add `agent-wiki import --format okf <path>`.
- Add round-trip tests using a committed OKF fixture.
- Decide whether export preserves generated indexes or rebuilds them on import.

Acceptance criteria:

- Exported packages can be copied to another machine and inspected without a
  running service.
- Import verifies raw hashes and package manifest before use.
- Optional vector indexes do not block import.

### Phase 5 - Compatibility And Governance

Goal: make OKF stable enough for external users.

Deliverables:

- Publish OKF v0.1 compatibility rules.
- Add migration notes for future format versions.
- Add a conformance fixture suite.
- Add a public "OKF compliance level" table:
  - basic: manifest + raw/wiki
  - evidence-first: basic + evidence report + page classes
  - compiler-grade: evidence-first + deterministic compiler artifacts

Acceptance criteria:

- Users can tell whether their package is valid.
- Future breaking changes require a documented migration.
- Third-party tools can validate OKF without running the full MCP server.

## README Upgrade Direction

README should not become a long specification. It should carry the strategic
story:

1. `agent-wiki` is not only an MCP wiki server.
2. It is becoming the reference implementation for OKF.
3. OKF means portable agent knowledge packages: raw evidence, compiled wiki,
   schemas, indexes, evidence, and logs.
4. Existing features already implement much of this.
5. The detailed plan lives in this document.

Suggested README positioning:

> agent-wiki is also evolving into the reference implementation of Open
> Knowledge Format (OKF): a Git-native package format for agent-maintained
> knowledge with immutable sources, mutable compiled pages, evidence metadata,
> and machine-checkable governance.

## Recommended Next Engineering Issue

Start with Phase 1.

Issue title:

> Add OKF v0.1 manifest schema and format-check action

Scope:

- create `schemas/agent-wiki-okf.schema.json`
- add manifest loader
- add `wiki_admin action: "format-check"`
- add one valid fixture and three invalid fixtures
- document the command in `docs/tools.md`

Why this first:

- It is small enough to ship quickly.
- It makes OKF executable rather than only conceptual.
- It does not disrupt current users.
- It creates the anchor needed for export/import later.

## References

- Open Definition 2.1: https://opendefinition.org/od/2.1/en/
- Open Knowledge Foundation: https://okfn.org/en/
- Data Commons paper: https://arxiv.org/abs/2309.13054
- Google Data Commons overview: https://research.google/pubs/data-commons/
- LLM-Wiki paper: https://arxiv.org/abs/2605.25480
