# PRD: Legacy Code Knowledge Compiler

## Status

Draft

## Summary

Build a vertical product line inside `agent-wiki` that compiles legacy systems
into a durable, queryable, evidence-backed knowledge base. The initial focus is
COBOL-centric systems and adjacent operational artifacts such as copybooks, JCL,
batch structure, file interfaces, and database usage.

This product line should turn a pile of legacy assets into:

- structured wiki pages
- machine-readable dependency and lineage graphs
- grounded retrieval surfaces
- impact-analysis outputs
- explicit uncertainty signals where understanding is incomplete

## Problem

Legacy systems are usually maintained through:

- fragmented documents
- code-level tribal knowledge
- batch scripts and deployment artifacts
- institutional memory trapped in senior engineers

Teams struggle with:

- onboarding new maintainers
- estimating change impact
- identifying shared copybooks and common data structures
- tracing field movement across programs and jobs
- modernization and migration planning
- answering audit and operations questions with evidence

Generic search and generic code assistants help at the margin, but they often
fail at two things that matter most in this space:

- grounding answers in system structure and source evidence
- surfacing uncertainty when the system model is incomplete

## Product Goal

Create a compiler-like pipeline that transforms raw legacy system assets into a
knowledge model that supports:

- system understanding
- maintenance
- change impact analysis
- modernization planning
- auditability

## Users

Primary users:

- legacy application maintainers
- modernization teams
- enterprise architects
- platform and reliability teams supporting batch systems
- consulting and outsourcing teams inheriting systems

Secondary users:

- engineering managers
- audit and risk partners
- internal documentation and knowledge management teams

## Initial Scope

The first supported vertical is COBOL-based systems.

In scope for the first major phase:

- COBOL programs
- COBOL copybooks
- procedure sections and paragraphs
- variables and data items
- CALL / PERFORM / COPY relationships
- generated program and copybook wiki pages
- aggregate call graph pages
- variable trace queries

Next-in-scope after core COBOL:

- JCL jobs and steps
- job-to-program invocation mapping
- dataset / file usage
- DB2 and CICS references where detectable
- batch flow aggregation

Out of scope for the initial phase:

- broad multi-language support beyond one deep wedge
- source-to-source code migration
- automatic code rewriting
- full runtime observability ingestion

## Product Thesis

The product is not a code summarizer.

It is a knowledge compiler for legacy systems.

That means:

1. parse source artifacts deterministically
2. normalize them into a stable intermediate model
3. resolve cross-file and cross-runtime relationships
4. emit human-readable knowledge pages and machine-readable graph outputs
5. expose confidence gaps, unresolved references, and unsupported claims

## Core Use Cases

### 1. Understand a program quickly

A maintainer should be able to ingest a COBOL program and get:

- structure
- paragraphs and sections
- copybook dependencies
- key data items
- likely call targets
- related wiki pages

### 2. Trace a field or variable

A user should be able to ask:

- where is `WS-TOTAL-SALARY` read and written?
- which procedures mutate a control field?
- where is a particular record layout shared?

### 3. Build a system map

A team should be able to compile multiple programs and produce:

- call graph
- shared copybook graph
- job/step/program graph
- file and table usage map

### 4. Estimate change impact

A user should be able to ask:

- if I change this copybook, what programs are affected?
- if I modify this field, what downstream jobs or reports might break?
- what batch steps depend on this program?

### 5. Support modernization work

A team should be able to use the compiled knowledge base to identify:

- tightly coupled areas
- shared schemas and copybooks
- dead or low-visibility programs
- migration candidates and risk clusters

## User Value

The system should reduce time and uncertainty in:

- onboarding
- incident response
- maintenance planning
- impact analysis
- modernization discovery

The strongest value proposition is not convenience. It is reduced risk with
traceable evidence.

## Current Starting Point

The current `agent-wiki` codebase already provides:

- a plugin architecture for code analysis
- a COBOL parser and normalized model path
- variable tracing
- wiki page generation for programs and copybooks
- aggregate call graph generation
- raw source storage and provenance
- wiki generation and search surfaces

This PRD extends that foundation into a deeper vertical product.

## Product Requirements

### A. Deterministic extraction first

The core facts must come from deterministic parsing and resolution wherever
possible.

Examples:

- program IDs
- sections and paragraphs
- data items
- CALL / PERFORM / COPY relationships
- file and table references where parseable

Agent synthesis may add summaries and semantic grouping, but it must not be the
sole source of core structural facts.

### B. Stable intermediate model

The compiler must maintain a normalized, machine-readable model across files and
artifacts, not only emit Markdown pages.

The model should eventually represent entities such as:

- program
- copybook
- job
- step
- file or dataset
- table
- field
- procedure
- dependency edge

### C. Cross-artifact resolution

The system must move beyond single-file analysis.

It should resolve:

- copybook reuse across programs
- program invocation across jobs and steps
- field definitions shared across copybooks and records
- file and table access patterns across the system

### D. Evidence-backed outputs

Every generated page or impact result should retain links to its sources:

- raw source file
- source location where feasible
- generated model artifact

### E. Uncertainty visibility

The system must explicitly surface:

- unresolved call targets
- unresolved copybook references
- ambiguous field mappings
- inferred relationships with lower confidence

This is important both for trust and for agent behavior.

## Functional Requirements

### Phase 1: COBOL core compiler

- Parse `.cbl`, `.cob`, `.cpy`
- Normalize program structure
- Generate program and copybook wiki pages
- Build aggregate call graph page
- Support variable tracing
- Persist parse and model artifacts to `raw/parsed/cobol/`

### Phase 2: Batch/runtime compiler

- Parse JCL jobs and steps
- Map job step -> invoked program
- Extract datasets and file references
- Generate batch-flow wiki pages
- Build job/program/file relationship graph

### Phase 3: Data usage and lineage

- Identify read/write access patterns to files and tables
- Link fields across copybooks and programs where possible
- Surface record and field lineage candidates
- Support impact queries over field and file changes

### Phase 4: Impact analysis surface

- Query affected programs for a changed copybook
- Query affected jobs for a changed program
- Query likely downstream artifacts for a changed field
- Return evidence chains and uncertainty markers

## Non-Functional Requirements

- outputs must remain Git-native and inspectable
- compiled knowledge must be regenerable from raw sources
- browser visualization must remain optional, not foundational
- the system should degrade gracefully when resolution is incomplete
- source evidence must survive summarization

## Experience Principles

- show the system model, not just prose summaries
- make evidence and uncertainty visible
- prioritize maintenance and impact workflows over decorative visualization
- prefer deterministic correctness over aggressive synthesis

## Differentiation

This product line differs from generic code assistants by emphasizing:

- compiler-style extraction, not just Q&A
- durable knowledge artifacts, not transient chat output
- evidence-backed system maps
- explicit abstention when evidence is weak
- deep vertical support in a legacy domain

## Technical Moat

The moat comes from accumulated vertical depth, not from a single feature.

Expected moat layers:

1. parsers and resolution logic for legacy artifacts
2. normalized intermediate models and graph schema
3. impact-analysis logic and heuristics
4. grounded retrieval and uncertainty signaling
5. evaluation corpus built from real legacy systems

Over time, each new customer or corpus should improve:

- parsing coverage
- resolution quality
- lineage quality
- impact-analysis accuracy
- benchmark depth

## Risks

### 1. Shallow multi-language expansion

Trying to support many ecosystems too early would weaken the wedge.

Mitigation:

- go deep on COBOL first
- only expand once one vertical loop is strong

### 2. Over-reliance on LLM summaries

This would reduce trust.

Mitigation:

- deterministic extraction first
- label inferred or synthesized conclusions clearly

### 3. Attractive but low-value UI work

Graphs are useful, but not the core moat.

Mitigation:

- invest first in resolution, lineage, and impact APIs

### 4. Weak evaluation discipline

Without strong evals, the system may feel plausible without being reliable.

Mitigation:

- add corpus-driven tests and accuracy measures early

## Success Metrics

Product metrics:

- time-to-understand for a new program
- time-to-answer common impact questions
- number of compiled artifacts per system
- coverage of ingested legacy assets

Quality metrics:

- parse success rate
- unresolved reference rate
- variable trace accuracy
- call graph precision and recall on benchmark corpora
- impact-analysis accuracy on known change scenarios

Adoption metrics:

- number of systems compiled
- repeated use in maintenance and modernization workflows
- retained usage by consulting or internal platform teams

## Roadmap

### Next 6 weeks

- harden COBOL compiler outputs
- improve generated program pages
- add richer aggregate pages
- define the cross-artifact graph schema
- define evaluation fixtures and baseline metrics

### 6-12 weeks

- add JCL parsing
- add job/step/program linking
- add dataset extraction and batch flow pages
- expose first impact-analysis queries

### 3-6 months

- add file/table access classification
- add first field-lineage capabilities
- add retrieval evidence and abstain signals for compiler-generated knowledge
- build modernization-oriented summary pages and reports

## Open Questions (Resolved)

### 1. Should JCL live inside the COBOL plugin family or become its own plugin?

**Decision: Independent plugin.**

JCL is a job/batch orchestration layer; COBOL is a program logic layer — their
concerns are fundamentally different. The only shared surface is cross-references
(job step → program), which are modeled as graph edges (`EXECUTES`) rather than
internal plugin coupling. This keeps each plugin focused:

- `cobol` plugin: parse programs, copybooks, sections, variables, CALL graph
- `jcl` plugin: parse jobs, steps, DD statements, dataset references, proc includes

Cross-artifact links are resolved at the **graph layer**, not inside either plugin.

### 2. What is the minimum viable graph schema for cross-artifact impact analysis?

**Decision: 5 node types + 4 edge types.**

Nodes:

| Node Type   | Source        | Example                        |
|-------------|---------------|--------------------------------|
| `Program`   | COBOL parser  | GS029C, GS627C                |
| `Copybook`  | COBOL parser  | WSGESCOM, TABELLE665           |
| `Job`       | JCL parser    | NIGHTLY-SETTLE                 |
| `Step`      | JCL parser    | STEP010                        |
| `Dataset`   | JCL parser    | HLQ.PROD.TRANS.FILE            |

Edges:

| Edge Type      | From → To         | Source              |
|----------------|-------------------|---------------------|
| `CALLS`        | Program → Program | CALL statement      |
| `COPIES`       | Program → Copybook| COPY statement      |
| `EXECUTES`     | Step → Program    | EXEC PGM=           |
| `READS/WRITES` | Step → Dataset    | DD statement (DISP) |

Field-level lineage (column → column) is deferred to Phase 3.

### 3. How should inferred relationships be labeled and scored?

**Decision: Three-tier confidence model with provenance.**

| Confidence Level   | Meaning                                         | Example                                      |
|--------------------|------------------------------------------------|----------------------------------------------|
| `deterministic`    | Parsed directly from source — no inference      | `CALL 'GS029C'` → static call edge          |
| `inferred-high`    | Dynamic but target is resolvable/unique         | `CALL WS-PGM` where WS-PGM is set once      |
| `inferred-low`     | Heuristic match, naming convention, or guess    | Variable name similarity across copybooks    |

Every edge carries two metadata fields:
- `confidence`: one of the three tiers above
- `evidence`: source file + line number (or reasoning trace for inferred)

Wiki pages and graph views surface confidence visually — `inferred-low` edges
are rendered as dashed lines with a warning indicator.

### 4. When should summaries be generated automatically versus on demand?

**Decision: Deterministic facts auto-generate; business interpretation on demand.**

| Category                | Generation | Method        | Label           |
|-------------------------|------------|---------------|-----------------|
| Program structure       | Automatic  | Parser        | `deterministic` |
| Call graph / copy tree  | Automatic  | Parser        | `deterministic` |
| Variable trace          | Automatic  | Parser        | `deterministic` |
| Section control flow    | Automatic  | Parser        | `deterministic` |
| Business purpose        | On demand  | LLM synthesis | `synthesized`   |
| Migration risk summary  | On demand  | LLM synthesis | `synthesized`   |

Auto-generated pages are idempotent — re-running the compiler on the same source
produces identical output. On-demand summaries are explicitly labeled
`synthesized` in frontmatter and body, so consumers always know the provenance.

## Decision

`Legacy Code Knowledge Compiler` is the preferred vertical wedge for deepening
`agent-wiki`.

The immediate execution strategy is:

- stay narrow
- go deep on COBOL and adjacent runtime artifacts
- build deterministic cross-artifact knowledge before broadening to more languages
