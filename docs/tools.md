# MCP Tools Reference

agent-wiki exposes 15 public tools through the Model Context Protocol.

## Raw Layer — Immutable Sources

| Tool | Description |
|------|-------------|
| `raw_ingest` | Unified raw ingestion tool. Select `mode`: `add` (content/local file/directory), `fetch` (download from URL), `import_confluence`, or `import_jira`. Preserves immutable raw semantics with `.meta.yaml` sidecars. |
| `raw_list` | List all raw documents with metadata (path, source URL, hash, size) |
| `raw_coverage` | Report which raw files have not yet been referenced by any wiki page. Answers "what should I compile next?" Returns coverage ratio + an uncovered list (sortable by `newest`/`oldest`/`largest`, filterable by tag). Matches frontmatter `sources` and inline `raw/...` body references; excludes `raw/parsed/` artifacts. |
| `raw_read` | Read a raw document — text/SVG return content; PDF/DOCX/XLSX/PPTX extracted automatically; images returned inline (<10MB); other binary return metadata only. Supports pagination to bypass the 10K char default truncation: `pages` for PDF/PPTX ranges, `sheet` for a specific XLSX sheet, `offset`+`limit` for line-based reading of DOCX and text files. Paginated responses include metadata (`total_pages`, `sheet_names`, `total_lines`, etc.) for follow-up reads. |
| `raw_versions` | List all versions of a file with metadata, returns latest version |

## Wiki Layer — Compiled Knowledge

| Tool | Description |
|------|-------------|
| `wiki_read` | Read a page (frontmatter + Markdown). Pass `pages: [...]` to read multiple pages in one request — saves N-1 round trips vs individual reads. |
| `wiki_write` | Create or update a page (auto-timestamps, auto-classify, auto-route to nested dirs, auto-link). Triggers index rebuild. Pass `return_content: true` to get the final page content back — eliminates a follow-up `wiki_read`. Response includes `autoLinked` count. |
| `wiki_delete` | Delete a page (guards system pages). Triggers index rebuild — stale indexes and empty dirs are cleaned up. |
| `wiki_list` | List pages, filter by entity type or tag |
| `wiki_search` | Full-text search with BM25 scoring, synonym expansion, fuzzy matching, and CJK support. Use `type` or `tags` to filter without a separate `wiki_list` call. Optional hybrid BM25+vector mode: enable `search.hybrid: true` in `.agent-wiki.yaml`, then run `wiki_admin` with `action: "rebuild"` to embed all pages. Returns `knowledge_gap` when no results found — includes suggested page slug, title, type, and tags for `wiki_write`. |
| `wiki_admin` | Unified wiki maintenance tool. Select `action`: `init`, `config`, `rebuild`, or `lint`. `rebuild` regenerates indexes/timeline and search vectors; `lint` runs health checks and optional auto-fixes. |

## Code Analysis — Language Plugins

| Tool | Description |
|------|-------------|
| `code_parse` | Parse a source file from raw/ into structured code knowledge (AST, normalized model, summary). Generates wiki pages automatically. Currently supports COBOL (.cbl, .cob, .cpy) — extracts CALL/PERFORM/COPY structure, data items including LINKAGE SECTION, EXEC SQL/CICS references, file access modes, and CALL USING positional arguments. Each parse refreshes three cross-file lineage families (shared-copybook fields, CALL boundary flow, DB2 table flow) and the cross-file knowledge graph. Optionally traces a variable. |
| `code_query` | Unified code query tool. Select `query_type`: `trace_variable`, `impact`, `procedure_flow`, or `field_lineage`. This is the main query surface over parsed and compiled code artifacts. |

### `code_query` query types

| Query Type | Description |
|------------|-------------|
| `trace_variable` | Trace all references to a variable across one parsed source file, grouped by section/paragraph. |
| `impact` | Query the compiled COBOL knowledge graph for downstream impact. Returns affected nodes grouped by dependency depth, with evidence and unresolved/lower-confidence markers. |
| `procedure_flow` | Query PERFORM flow inside one parsed source file. Returns section-level and paragraph-level flow, plus optional focused traversal from one procedure. |
| `field_lineage` | Query compiled field-lineage artifacts. Returns matches across three lineage families: deterministic shared-copybook reuse, inferred cross-copybook candidates (high-confidence + ambiguous), CALL boundary field flow (caller USING ↔ callee LINKAGE), and DB2 cross-program data flow via shared tables (writer/reader pairs with host variables). Each family appears only if the corresponding parsed evidence exists. |

## Orchestration

| Tool | Description |
|------|-------------|
| `knowledge_ingest` | Unified knowledge ingestion tool. Select `mode`: `batch` (scan/chunk/source-pack ingest) or `digest_write` (materialize digest items into wiki pages). |
| `batch` | Execute multiple tool calls in one round trip. Supports deferred rebuild semantics so write-heavy flows only rebuild indexes/graphs once at the end. |

The code analysis system is plugin-based with a language-agnostic `NormalizedCodeModel`. See [`code-analysis-plugins.md`](code-analysis-plugins.md) for the full pipeline diagram and the `CodeAnalysisPlugin` interface used to add new languages.

```
raw/PAYROLL.cbl
  → code_parse
    → raw/parsed/cobol/PAYROLL.ast.json        (language-specific AST)
    → raw/parsed/cobol/PAYROLL.normalized.json  (language-agnostic model)
    → raw/parsed/cobol/PAYROLL.summary.json     (summary statistics)
    → raw/parsed/cobol/PAYROLL.model.json       (COBOL-specific model)
    → wiki/code-payroll.md                      (auto-generated wiki page)
    → wiki/code-call-graph.md                   (aggregate call graph)
```

### Normalized Code Model

All language plugins emit a common `NormalizedCodeModel`:

| Field | Description |
|-------|-------------|
| `units` | Programs, classes, modules, copybooks |
| `procedures` | Functions, methods, paragraphs, sections |
| `symbols` | Variables, fields, constants, parameters |
| `relations` | Calls, performs, includes, imports |
| `diagnostics` | Warnings and errors from parsing |

### Removed Tools

These tools were consolidated into other tools and are no longer part of the default public MCP surface:

| Former Tool | Replacement |
|-------------|-------------|
| `raw_verify` | `wiki_admin` with `action: "lint"` — includes SHA-256 integrity checks |
| `wiki_log` | `wiki_read("log.md")` — read the log page directly |
| `wiki_classify` | `wiki_write` — auto-classifies internally when no type is specified |
| `wiki_synthesize` | Agent calls `wiki_read` on multiple pages directly |
| `wiki_schemas` | `wiki_admin` with `action: "config"` — returns entity templates alongside configuration |
| `wiki_rebuild_index` / `wiki_rebuild_timeline` | `wiki_admin` with `action: "rebuild"` — single tool rebuilds both |
| `raw_add` / `raw_fetch` / `raw_import_confluence` / `raw_import_jira` | `raw_ingest` with `mode` |
| `wiki_init` / `wiki_config` / `wiki_rebuild` / `wiki_lint` | `wiki_admin` with `action` |
| `code_trace_variable` / `code_impact` | `code_query` with `query_type` |
| `knowledge_ingest_batch` / `knowledge_digest_write` | `knowledge_ingest` with `mode` |

## Directory Structure & Auto-Generated Indexes

Pages can be organized into nested directories. `wiki_admin` with `action: "rebuild"` (and every `wiki_write`/`wiki_delete`) automatically generates `index.md` at each directory level.

```
wiki/
  index.md              ← top-level hub (auto-generated)
  log.md                ← operation log (auto-generated)
  timeline.md           ← chronological view (auto-generated)
  note-misc.md
  lang/
    index.md            ← lists js/, python/ sub-topics (auto-generated)
    js/
      index.md          ← lists JS pages by type (auto-generated)
      concept-closures.md
      concept-promises.md
    python/
      index.md          ← lists Python pages by type (auto-generated)
      concept-decorators.md
```

### Reserved paths

All `*/index.md` paths are **system-reserved** for auto-generated directory indexes. They cannot be created or deleted through `wiki_write` / `wiki_delete`. They are fully managed by the rebuild process.

### Auto-routing

`wiki_write` automatically routes root-level pages to matching nested directories:

1. **Explicit `topic` field** — `topic: "js"` in frontmatter matches `lang/js/` (deepest match wins)
2. **Tag/title matching** — title words and tags are matched against existing directory names
3. **Deepest match wins** — `lang/js/` is preferred over `lang/` for a JS-related page

### Stale cleanup

When the last page in a subtree is deleted, `wiki_admin` with `action: "rebuild"` removes the stale `index.md` and cleans up empty parent directories automatically.

## Entity Types

| Type | Use Case | Example |
|------|----------|---------|
| `person` | People profiles | Researchers, engineers, historical figures |
| `concept` | Ideas and definitions | YOLO, attention mechanism, GIL |
| `event` | Things that happened | Conference talks, releases, incidents |
| `artifact` | Created things | Papers, tools, models, datasets |
| `code` | Code examples and snippets | Implementation patterns, code recipes |
| `comparison` | Side-by-side analysis | YOLOv8 vs YOLOv9, PyTorch vs TensorFlow |
| `summary` | Document summaries | Paper summaries, article digests |
| `how-to` | Procedures and guides | Setup guides, deployment steps |
| `note` | Freeform knowledge | Anything that doesn't fit other types |
| `synthesis` | Distilled knowledge | Insights from combining multiple pages |

## Page Format

```markdown
---
title: YOLO Object Detection
type: concept
tags: [yolo, detection, computer-vision]
sources: [paper-yolo-v1.pdf]
created: "2026-04-05T12:00:00.000Z"
updated: "2026-04-05T14:30:00.000Z"
---

# YOLO Object Detection

You Only Look Once — real-time object detection.

Related: [[comparison-detectors]], [[person-redmon]]
```

Synthesis pages track their derivation:

```markdown
---
title: Object Detection Overview
type: synthesis
derived_from: [concept-yolo.md, concept-ssd.md, concept-rcnn.md]
---
```

## Search

`wiki_search` uses a local BM25 engine — zero LLM dependency, deterministic, low-latency.

| Feature | Details |
|---------|---------|
| **Field-weighted BM25** | Five fields scored independently: title (4×), tags (3×), slug (3×), frontmatter (1.5×), body (1×) |
| **Inverted index** | Postings-based O(1) term lookup. Lazy build with incremental invalidation on write/delete. |
| **Synonym expansion** | Built-in abbreviation table (e.g. `llm` → large language model, `k8s` → kubernetes). Expanded terms scored at 0.4× weight. |
| **Prefix matching** | Partial terms match in title, tags, and slug fields (e.g. `deploy` matches `deployment`) |
| **Fuzzy matching** | Levenshtein edit distance — 1 for 4–7 char terms, 2 for 8+ chars. Latin only. |
| **CJK tokenization** | `Intl.Segmenter` word segmentation + 2/3-gram fallback for Chinese, Japanese, Korean text |
| **Exact phrase boost** | Full query phrase in title (+8), slug (+6), or body (+3) |
| **Postings union** | Only scores documents containing at least one query term — skips the rest of the corpus |

### Hybrid BM25+Vector Search

Hybrid mode re-ranks BM25 candidates using dense vector similarity, improving recall for semantic queries ("how does auth work?" rather than exact keywords).

**Setup** (one-time, ~90 MB model download):

1. Add to `.agent-wiki.yaml`:

```yaml
search:
  hybrid: true
```

2. Run `wiki_admin` with `action: "rebuild"` once to embed all existing pages. The sentence-transformer model (`Xenova/all-MiniLM-L6-v2`) is downloaded from HuggingFace Hub and cached locally.

After setup, every `wiki_write` automatically embeds the new page — no manual steps needed.

**How it works:**

| Step | Description |
|------|-------------|
| BM25 pre-filter | Fetch 3× the requested result count using the BM25 index |
| Embed query | Compute a 384-dim dense vector for the query |
| Cosine re-rank | Score each candidate: `bm25_weight × norm_bm25 + vector_weight × cosine` |
| Return top-N | Final ranked list blends lexical and semantic signals |

**Configuration:**

| Key | Default | Description |
|-----|---------|-------------|
| `search.hybrid` | `false` | Enable hybrid mode |
| `search.model` | `Xenova/all-MiniLM-L6-v2` | Sentence-transformer model |
| `search.bm25_weight` | `0.5` | Weight for the normalized BM25 score |
| `search.vector_weight` | `0.5` | Weight for cosine similarity |

**Graceful degradation:** If the embedding model fails or `@xenova/transformers` is unavailable, `wiki_search` silently falls back to pure BM25 — searches never fail.

**Vector index persistence:** Embeddings are cached in `wiki/.search-vectors.json`. The index is invalidated and rebuilt automatically if you change `search.model`.

## Auto-Linking

Every `wiki_write` automatically scans the page body for mentions of existing page titles and injects `[[slug|text]]` links:

```
Before: "We use YOLO Object Detection for inference."
After:  "We use [[concept-yolo|YOLO Object Detection]] for inference."
```

Rules:
- Only titles ≥ 4 characters are matched (avoids noise from short tokens)
- Each page is linked **at most once** — first occurrence wins
- **Longest title wins** when two candidates overlap (`YOLO Object Detection` beats `YOLO`)
- Self-references are excluded (a page never links to itself)

Skipped zones (never modified):
- Fenced code blocks (``` or ~~~)
- Inline code (`` `...` ``)
- Existing `[[wiki links]]`
- Markdown `[text](url)` links
- Bare URLs (`https?://...`)

The `autoLinked` count in the response shows how many links were injected. Link extraction (`page.links`) correctly handles `[[slug|display text]]` by stripping the display part. Word-boundary detection is Unicode-aware (`\p{L}\p{N}`) so CJK text is handled correctly.

**Disable auto-linking** (per workspace):

```yaml
# .agent-wiki.yaml
auto_link:
  enabled: false
```

When `return_content: true`, the returned content includes the timestamps injected by the write step (accurate reflection of what is on disk).

## Auto-Classification

Every `wiki_write` automatically classifies content if no type is specified:

```
Input:  "# YOLO Object Detection\n\nYOLO is a real-time detection model..."
Output: { type: "concept", tags: ["yolo", "object-detection", "real-time"], confidence: 0.8 }
```

Pure heuristic — no LLM calls, no API keys, zero latency. Supports English and Chinese.
