# Open Knowledge Format

This document defines the Open Knowledge Format direction for `agent-wiki`.

The name intentionally borrows from the Open Knowledge Foundation's open knowledge principles, not from a Google product. Google Data Commons and recent LLM-Wiki research are important adjacent references, but `agent-wiki` should define its own Git-native package format for agent-maintained knowledge.

For the current-state audit, feasibility assessment, and phased implementation
plan, see [`okf-adoption-plan.md`](okf-adoption-plan.md).

## Position

`agent-wiki` should become:

> an open, machine-readable, Git-native knowledge package format for AI agents

This means a knowledge base is not only a set of Markdown notes. It is a portable package with immutable source evidence, compiled wiki pages, schemas, provenance, indexes, and lintable policies.

## Why This Matters

Most retrieval systems expose knowledge as query-time chunks. That is useful, but it leaves core lifecycle questions unresolved:

- What source material produced this claim?
- Can another agent import and inspect the knowledge base without vendor lock-in?
- Which pages are grounded, synthesized, stale, or unsupported?
- Which source documents are still uncompiled?
- Can the knowledge base be diffed, reviewed, reverted, and audited?

The Open Knowledge Format answers these questions through files that can live in any Git repository.

## Relationship To OKF

OKF here means Open Knowledge Foundation and the broader open knowledge tradition.

The Open Definition states that knowledge is open when people are free to access, use, modify, and share it, subject at most to measures that preserve provenance and openness. It also requires machine readability and open formats.

For `agent-wiki`, that translates into product requirements:

- the package should use plain, inspectable files
- the package should declare license and source policy
- source evidence should preserve provenance
- compiled knowledge should be editable and reviewable
- format rules should be documented and lintable
- no hosted service should be required to read or move the package

## Relationship To Google Data Commons

Google Data Commons is an open knowledge graph for public datasets. It standardizes public data through schemas and APIs so different Data Commons instances can interoperate and be queried as a larger graph.

`agent-wiki` is different:

- Data Commons is primarily a structured public data graph.
- `agent-wiki` is a repository-native knowledge compiler for agents.
- Data Commons normalizes datasets into common schemas and APIs.
- `agent-wiki` preserves raw evidence, compiles mutable wiki pages, and records provenance for agent use.

The useful lesson is interoperability: a knowledge package should be portable, schema-aware, and queryable without assuming one central host.

## Relationship To LLM-Wiki

LLM-Wiki research argues that agent retrieval should work more like reasoning: search, read, traverse links, and correct structural errors over time. That aligns strongly with `agent-wiki`.

The difference is implementation emphasis:

- LLM-Wiki is a retrieval architecture pattern.
- `agent-wiki` should be a concrete package format and toolchain.
- LLM-Wiki focuses on agent-native retrieval behavior.
- `agent-wiki` adds Git-native provenance, source immutability, lint, evidence envelopes, and package-level governance.

## Package Layout

A conforming Open Knowledge Format package should use this shape:

```text
agent-wiki-package/
  agent-wiki.yaml
  raw/
  wiki/
  schemas/
  indexes/
  evidence/
  logs/
```

### `agent-wiki.yaml`

Package manifest.

Minimum fields:

```yaml
name: payroll-modernization-knowledge
version: 0.1.0
license: MIT
format: agent-wiki-okf
format_version: 0.1
owner: platform-team
created_at: 2026-06-20
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

The manifest is the package contract. OKF v0.1 manifests are validated by
`wiki_admin action: "format-check"` against
`schemas/agent-wiki-okf.schema.json` and deterministic validation rules. The
same check now includes a package inventory and conformance findings; use
`wiki_admin action: "rebuild"` with `okf_report: true` to persist that report at
`evidence/okf-report.json`.

### `raw/`

Immutable source evidence.

Rules:

- raw files are write-once
- each raw file should have a stable hash
- re-ingesting a same-name source creates a new version rather than mutating the old one
- raw files should be cited by compiled wiki pages through frontmatter `sources`

### `wiki/`

Mutable compiled knowledge.

Rules:

- pages are Markdown
- pages use `[[wikilinks]]` for graph edges
- pages should include frontmatter describing type, sources, synthesis status, freshness, and confidence where applicable
- pages may be rewritten as understanding improves

Example:

```markdown
---
type: system-component
sources:
  - raw/PAYROLL.cbl
evidence:
  confidence: strong
  basis: deterministic
---

# PAYROLL

Compiled operational knowledge about the PAYROLL program.
```

### `schemas/`

Reusable page and entity templates.

Schemas should define expected frontmatter, required sections, and entity-specific fields. They are not only documentation; they should become validation inputs.

### `indexes/`

Derived search and graph artifacts.

Examples:

- BM25 index metadata
- vector index metadata when hybrid search is enabled
- link graph snapshots
- directory-level topic indexes

Indexes are rebuildable. They should not be treated as primary evidence.

### `evidence/`

Provenance, claim lineage, and confidence artifacts.

This layer complements page-level frontmatter and tool responses. It should support questions like:

- Which raw sources support this page?
- Which claims are synthesized from multiple sources?
- Which pages are unsupported?
- Which retrieval answers should abstain?

### `logs/`

Operational telemetry for improvement loops.

Examples:

- unsupported write logs
- search abstain logs
- coverage reports
- lint reports
- future agent edit proposals

Logs are evidence for maintaining the knowledge package, not the package's source of truth.

## Page Classes

The format should distinguish at least these page classes:

| Class | Meaning | Required evidence |
|-------|---------|-------------------|
| grounded | directly supported by raw sources | `sources` required |
| synthesis | combines multiple grounded pages or sources | `synthesis: true` and rationale |
| index | navigational or generated overview | generation metadata |
| unsupported | agent-authored without sources | flagged and discouraged |
| stale | source-backed but likely outdated | freshness metadata |

This classification is central to agent behavior. Agents should treat unsupported and stale pages differently from grounded pages.

## Interoperability Principles

A conforming package should be:

- **file-native**: readable without a database
- **Git-native**: diffable, reviewable, revertable
- **machine-readable**: manifests and frontmatter parse cleanly
- **open-format**: no proprietary container required
- **portable**: can move across MCP clients and agent runtimes
- **provenance-preserving**: source evidence survives export/import
- **lintable**: structural and evidence rules are checkable

## Non-Goals

This format is not:

- a replacement for RDF, Wikidata, or Data Commons
- a hosted knowledge graph service
- a vector database format
- a claim that all knowledge must be open-licensed
- a model training dataset format

It is a package format for agent-maintained operational knowledge.

## Initial Compliance Checklist

A repository is OKF-aligned when:

- it has an `agent-wiki.yaml` manifest
- raw sources are immutable and hashable
- wiki pages use Markdown with parseable frontmatter
- grounded pages cite raw sources
- synthesis pages are marked as synthesis
- generated indexes are rebuildable
- lint reports broken links, unsupported pages, stale pages, and raw coverage
- the package can be copied to another machine and read without hosted services

## Roadmap

Near-term:

1. Define `agent-wiki.yaml` schema. Done for OKF v0.1.
2. Add `wiki_admin action: "format-check"`. Done for OKF v0.1.
3. Emit package metadata during `wiki_admin rebuild`. Done as
   `evidence/okf-report.json` with `okf_report: true`.
4. Add export/import tests for raw, wiki, schemas, indexes, and evidence.

Later:

1. Define a stable `format_version`.
2. Add compatibility guarantees.
3. Add a package conformance test suite.
4. Publish example OKF packages.

## References

- Open Definition 2.1: https://opendefinition.org/od/2.1/en/
- Open Knowledge Foundation: https://okfn.org/en/
- Data Commons paper: https://arxiv.org/abs/2309.13054
- Google Agent2Agent Protocol announcement: https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/
- LLM-Wiki paper: https://arxiv.org/abs/2605.25480
