# Request Optimization

How to minimize LLM requests when digesting documents and querying the wiki.

## Understanding the Constraints

### The binding limit: raw_read truncation

`raw_read` truncates text content at **10,000 characters per document** — regardless of context window size. This cap is what determines how much of a document your agent actually sees.

| Language | 10K chars ≈ tokens | Docs per 200k context |
|----------|--------------------|----------------------:|
| English  | ~2,500             | ~72                   |
| Chinese  | ~5,000             | ~36                   |

**Documents shorter than 10K chars** (~6-7 pages) are fully read — quality is high.  
**Documents longer than 10K chars** — only the first portion is read unless you paginate.

Check your corpus size before designing a workflow:

```bash
find raw/ -type f | xargs wc -c | tail -1
# bytes ÷ 4 ≈ tokens (English)
# bytes ÷ 2 ≈ tokens (Chinese)
```

---

## Pagination for Large Documents

When you specify a pagination parameter, `raw_read` bypasses the 10K truncation and returns the requested range in full, along with metadata for follow-up reads.

| Format | Param | Example | Response includes |
|--------|-------|---------|------------------|
| PDF    | `pages`  | `"1-10"`, `"3"`, `"1-3,7-10"` | `pagination.total_pages` |
| PPTX   | `pages`  | `"1-20"` | `pagination.total_slides` |
| XLSX   | `sheet`  | `"Revenue"` | `pagination.sheet_names`, `total_sheets` |
| DOCX / text | `offset` + `limit` | `offset: 0, limit: 200` | `pagination.total_lines`, `truncated`, `next_offset` |

**XLSX tip:** always read without `sheet` first — the response lists all available sheet names so you can then target each one individually.

**DOCX/text tip:** use `next_offset` from the response to paginate: if `truncated: true`, call again with `offset: <next_offset>`.

---

## Batch Digest Strategy

### How many docs per request?

Because `raw_read` caps each document at 10K chars, batching is predictable:

```
available context (e.g. 180k) ÷ tokens per doc = max docs per request
  English: 180k ÷ 2,500 ≈ 72 docs
  Chinese: 180k ÷ 5,000 ≈ 36 docs
```

For a 10 MB corpus, you need roughly 15–25 requests minimum — context window size doesn't change this math.

### Quality tradeoffs

| Approach | Requests | Per-doc depth | Cross-doc patterns |
|----------|:--------:|:-------------:|:------------------:|
| One doc at a time | N | High | Low |
| Batch by topic (10–15/group) | N/10 | Medium | High |
| All at once (50+) | 1 | Low / truncated | Medium |

The sweet spot for most use cases is **batching by topic**, 10–15 docs per request, and targeting synthesis pages as output.

### Output strategy: synthesis over individual pages

When batching, write one synthesis page per batch rather than one page per document:

```markdown
---
title: Q1 Engineering Reports — Key Findings
type: synthesis
derived_from: [report-jan.md, report-feb.md, report-mar.md]
---

# Cross-cutting insights from Q1 reports
...
```

Future queries read **1 page** instead of 15 individual reads — this is where the real request savings compound over time.

---

## Batch Tools

The `batch` tool collapses multiple operations into a single MCP request:

```json
{ "tool": "batch", "args": { "operations": [
  { "tool": "wiki_read",   "args": { "page": "concept-a.md" } },
  { "tool": "wiki_read",   "args": { "page": "concept-b.md" } },
  { "tool": "wiki_write",  "args": { "page": "synthesis-x.md", "content": "..." } }
]}}
```

| Workflow | Without batch | With batch | Savings |
|----------|:---:|:---:|:---:|
| Import 5 files | 5 | **1** | 80% |
| Digest 5 sources into wiki | 10 | **2** | 80% |
| Search + read top results | 6 | **1** | 83% |
| Ingest 50-file directory | 50+ | **1** | 98% |

**`wiki_search_read`** — Search + read top-N results in one call. Returns content inline with `nextReads` for follow-up.

**`knowledge_ingest_batch`** — Scan a directory, import files, extract text with provenance (per-page PDF, per-sheet XLSX, per-slide PPTX), chunk, and pack into digest packs — all in one request.

**`knowledge_digest_write`** — Write LLM-generated summaries back to wiki with structured provenance (`sources`, `sourcePacks`). Batch writes with one index rebuild at the end.
