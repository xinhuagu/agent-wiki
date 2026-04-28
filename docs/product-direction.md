# Product Direction

## Summary

`agent-wiki` is evolving from a Markdown-based agent memory tool into a
knowledge compiler for agents: a system that ingests raw source material,
compiles it into durable knowledge, keeps that knowledge inspectable, and
surfaces where it is weak, stale, or incomplete.

The product should stay grounded in a few core properties:

- plain Markdown remains the durable human-readable surface
- raw sources remain immutable and traceable
- knowledge pages remain mutable and improvable
- retrieval should become more explicit about weak evidence and unknowns
- vertical compilers should deepen the system where generic wiki tooling is weak

## Product Thesis

Most agent tooling still treats knowledge as either:

- transient context assembled at query time, or
- a thin notes layer with weak guarantees about provenance and correctness

`agent-wiki` should occupy a different position:

> a compiler for durable, inspectable, self-improving agent knowledge

This means the product is not only a storage surface. It is a pipeline that:

1. ingests source material
2. extracts structure
3. compiles structured knowledge pages and graphs
4. detects gaps, contradictions, and stale regions
5. supports grounded retrieval and explicit abstention when evidence is weak

## Current Foundations

The current codebase already has the right primitives:

- immutable `raw/` source layer with provenance
- mutable `wiki/` layer with structured Markdown pages
- `raw_coverage` to expose uncompiled source material
- `wiki_admin` to detect structural risk signals and rebuild compiled views
- `knowledge_ingest` to support compile loops without multiplying public tools
- `wiki_search` plus batched `wiki_read` to move retrieval closer to grounded reading
- pluggable code analysis with an initial COBOL implementation
- a standalone graph viewer for live knowledge visualization

These are more than utility features. Together they point toward a knowledge
compilation system rather than a simple note-taking tool.

## Chosen Wedge

The preferred near-term wedge is:

## Legacy Code Knowledge Compiler

This wedge is attractive because it has:

- high pain and high budget
- messy, fragmented, partially undocumented source material
- strong need for provenance and impact analysis
- poor fit for naive LLM summarization or generic RAG

The initial focus should be deep, not broad:

- start with COBOL
- then add runtime and batch context such as JCL
- then add data lineage and impact analysis

This wedge is a better path to technical moat than trying to compete as a
general-purpose knowledge base for every use case at once.

## Why This Wedge Can Create Moat

The moat does not come from a single feature like search, graph view, or wiki
editing. It comes from the combination of:

- domain-specific parsers and resolvers
- stable intermediate knowledge models
- deterministic graph construction
- evidence-backed wiki and graph outputs
- impact analysis over real system structure
- evaluation corpora and accuracy benchmarks accumulated over time

Over time, this can become difficult to replace because each new project
improves parsing rules, resolution heuristics, lineage logic, and test corpora.

## Non-Goals For Now

The near-term goal is not:

- becoming a generic IDE replacement
- optimizing for pretty visualization over grounded knowledge
- supporting many legacy languages shallowly
- relying on LLM judgment for core factual extraction

The product should prefer deterministic extraction first, agent synthesis second.

## Directional Priorities

Near-term priorities:

1. improve retrieval trust signals: weak evidence, abstain, evidence sufficiency
2. deepen the compile loop: coverage, freshness, contradiction, next-best work
3. build the legacy code compiler wedge around COBOL and adjacent artifacts
4. establish evaluation around groundedness and compiler accuracy

## What Success Looks Like

Success is not "the agent has a wiki."

Success is:

- a system can be ingested from raw operational artifacts and source code
- the resulting knowledge is inspectable and traceable
- users can ask impact and architecture questions with grounded answers
- the system knows when its evidence is weak
- maintenance, migration, and onboarding effort materially decrease
