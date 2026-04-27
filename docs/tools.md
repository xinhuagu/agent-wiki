# MCP Tools Reference

agent-wiki exposes 19 tools through the Model Context Protocol.

## Raw Layer — Immutable Sources

| Tool | Description |
|------|-------------|
| `raw_add` | Add a source document (content string, local file, or entire directory). SHA-256 hashed with `.meta.yaml` sidecar. Supports `auto_version` for same-name files and `pattern` filtering for directories. |
| `raw_fetch` | Download from URL to raw/ (smart arXiv handling — `arxiv.org/abs/XXXX` auto-converts to PDF) |
| `raw_list` | List all raw documents with metadata (path, source URL, hash, size) |
| `raw_coverage` | Report which raw files have not yet been referenced by any wiki page. Answers "what should I compile next?" Returns coverage ratio + an uncovered list (sortable by `newest`/`oldest`/`largest`, filterable by tag). Matches frontmatter `sources` and inline `raw/...` body references; excludes `raw/parsed/` artifacts. |
| `raw_read` | Read a raw document — text/SVG return content; PDF/DOCX/XLSX/PPTX extracted automatically; images returned inline (<10MB); other binary return metadata only. Supports pagination to bypass the 10K char default truncation: `pages` for PDF/PPTX ranges, `sheet` for a specific XLSX sheet, `offset`+`limit` for line-based reading of DOCX and text files. Paginated responses include metadata (`total_pages`, `sheet_names`, `total_lines`, etc.) for follow-up reads. |
| `raw_versions` | List all versions of a file with metadata, returns latest version |

## Atlassian — Confluence & Jira

| Tool | Description |
|------|-------------|
| `raw_import_confluence` | Import a Confluence page (+ child pages recursively) into raw/. Preserves hierarchy in `_tree.yaml`. Requires `CONFLUENCE_API_TOKEN` env var. |
| `raw_import_jira` | Import a Jira issue with fields, description, comments, attachments, and linked issues. Saves JSON + Markdown. Requires `JIRA_API_TOKEN` env var. |

## Wiki Layer — Compiled Knowledge

| Tool | Description |
|------|-------------|
| `wiki_read` | Read a page (frontmatter + Markdown). Pass `pages: [...]` to read multiple pages in one request — saves N-1 round trips vs individual reads. |
| `wiki_write` | Create or update a page (auto-timestamps, auto-classify, auto-route to nested dirs, auto-link). Triggers index rebuild. Pass `return_content: true` to get the final page content back — eliminates a follow-up `wiki_read`. Response includes `autoLinked` count. |
| `wiki_delete` | Delete a page (guards system pages). Triggers index rebuild — stale indexes and empty dirs are cleaned up. |
| `wiki_list` | List pages, filter by entity type or tag |
| `wiki_search` | Full-text search with BM25 scoring, synonym expansion, fuzzy matching, and CJK support. Use `type` or `tags` to filter without a separate `wiki_list` call. Optional hybrid BM25+vector mode: enable `search.hybrid: true` in `.agent-wiki.yaml`, then run `wiki_rebuild` to embed all pages. Returns `knowledge_gap` when no results found — includes suggested page slug, title, type, and tags for `wiki_write`. |
| `wiki_lint` | Health checks: contradictions (numeric/date, topic-isolated, unit-normalized), orphans, broken links (with "did you mean?" suggestions), SHA-256 integrity. Pass `apply_fixes: true` to auto-repair missing frontmatter. |
| `wiki_init` | Initialize a new knowledge base (creates wiki/, raw/, schemas/) |
| `wiki_config` | Show current workspace configuration, paths, and available entity templates |
| `wiki_rebuild` | Rebuild all `index.md` files (multi-level directory indexes) and `timeline.md` (chronological view). When `search.hybrid: true`, also embeds all pages to build the vector index (downloads ~90 MB model on first run). |

## Code Analysis — Language Plugins

| Tool | Description |
|------|-------------|
| `code_parse` | Parse a source file from raw/ into structured code knowledge (AST, normalized model, summary). Generates wiki pages automatically. Currently supports COBOL (.cbl, .cob, .cpy). Optionally traces a variable. |
| `code_trace_variable` | Trace all references to a variable across a parsed source file. Shows where it is read, written, or passed, grouped by section/paragraph. |
| `code_impact` | Query the compiled COBOL knowledge graph for downstream impact. Returns affected nodes grouped by dependency depth, with evidence and unresolved/lower-confidence markers. |

The code analysis system is plugin-based with a language-agnostic `NormalizedCodeModel`:

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

These tools were consolidated into other tools in v0.6.0:

| Former Tool | Replacement |
|-------------|-------------|
| `raw_verify` | `wiki_lint` — includes SHA-256 integrity checks |
| `wiki_log` | `wiki_read("log.md")` — read the log page directly |
| `wiki_classify` | `wiki_write` — auto-classifies internally when no type is specified |
| `wiki_synthesize` | Agent calls `wiki_read` on multiple pages directly |
| `wiki_schemas` | `wiki_config` — returns entity templates alongside configuration |
| `wiki_rebuild_index` / `wiki_rebuild_timeline` | `wiki_rebuild` — single tool rebuilds both |

## Directory Structure & Auto-Generated Indexes

Pages can be organized into nested directories. `wiki_rebuild` (and every `wiki_write`/`wiki_delete`) automatically generates `index.md` at each directory level.

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

When the last page in a subtree is deleted, `wiki_rebuild` removes the stale `index.md` and cleans up empty parent directories automatically.

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

2. Run `wiki_rebuild` once to embed all existing pages. The sentence-transformer model (`Xenova/all-MiniLM-L6-v2`) is downloaded from HuggingFace Hub and cached locally.

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
