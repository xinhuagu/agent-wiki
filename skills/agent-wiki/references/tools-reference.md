# Agent Wiki — Tool Parameter Reference

Complete parameter schemas for all 15 public tools.

Legacy tool names (raw_add, raw_fetch, raw_import_confluence, raw_import_jira, wiki_search_read, wiki_init, wiki_config, wiki_rebuild, wiki_lint, code_trace_variable, code_impact, knowledge_ingest_batch, knowledge_digest_write) remain supported for backward compatibility but are no longer listed in the public MCP tool surface.

---

## RAW LAYER

### raw_ingest

Ingest raw source documents. Select `mode` to control the ingestion method.

```json
{
  "mode": "(required) string — add | fetch | import_confluence | import_jira",

  "filename":   "[add] string — Filename in raw/ (e.g. 'paper.pdf'). For directory imports, becomes subdirectory prefix.",
  "content":    "[add] string — File content as string. Either content or source_path is required.",
  "source_path":"[add] string — Absolute path to local file or directory to copy into raw/.",
  "source_url": "[add/fetch] string — Original URL where the document was downloaded from",
  "description":"[add/fetch] string — Brief description",
  "tags":       "[add/fetch] string array — Tags for categorization",
  "auto_version":"[add] boolean — Create versioned copy if file exists (e.g. report_v2.xlsx). Default: false",
  "pattern":    "[add] string — Glob filter for directory imports (e.g. '*.html'). Ignored for single files.",

  "url":        "[fetch] string — URL to download. arXiv abs URLs auto-converted to PDF. [import_confluence] Confluence page URL. [import_jira] Jira issue URL.",
  "recursive":  "[import_confluence] boolean — Import child pages recursively (default: false)",
  "depth":      "[import_confluence] number — Max recursion depth (-1 = unlimited, default: 50 if recursive)",
  "auth_env":   "[import_confluence] string — Env var for auth (default: CONFLUENCE_API_TOKEN). [import_jira] Env var (default: JIRA_API_TOKEN)",
  "include_comments":    "[import_jira] boolean — Include comments (default: true)",
  "include_attachments": "[import_jira] boolean — Download attachments (default: true)",
  "include_links":       "[import_jira] boolean — Import linked issues (default: true)",
  "link_depth":          "[import_jira] number — Levels of linked issues to follow (default: 1)"
}
```

**mode: add** — `filename` required. Either `content` or `source_path` required.
Returns: `{ ok, document }` or `{ ok, imported, documents }` for directory.
Single image files (<10MB) returned inline — you MUST call wiki_write to describe them.

**mode: fetch** — `url` required.
Returns: `{ ok, document }`. Single images (<10MB) returned inline.

**mode: import_confluence** — `url` required. Requires `CONFLUENCE_API_TOKEN='email:api-token'`.
Returns: `{ ok, pages, files, tree }`

**mode: import_jira** — `url` required. Requires `JIRA_API_TOKEN='email:api-token'`.
Returns: `{ ok, issueKey, summary, files, linkedIssues, importedCount }`

### raw_list

List all raw documents with metadata. No parameters.

```bash
agent-wiki call raw_list
```

Returns: `{ documents: [...], count: N }`

### raw_read

Read a raw document's content and metadata.

```json
{
  "filename": "(required) string — Path relative to raw/ (e.g. 'article.md')",
  "pages":  "string — Page/slide range (e.g. '1-5', '3', '1-3,7-10'). PDF and PPTX only.",
  "sheet":  "string — Sheet name for XLSX files (e.g. 'Revenue'). Omit to read all sheets.",
  "offset": "number — Line offset for DOCX/text pagination. Default: 0.",
  "limit":  "number — Max lines for DOCX/text pagination. Default: 200, max: 500."
}
```

**Default behavior (no pagination params):**
- Text/SVG: full content, truncated at 10K chars
- PDF/DOCX/XLSX/PPTX: auto-extracted text, truncated at 10K chars
- Images (<10MB): returned inline (no truncation)
- Other binary: metadata only

**With pagination params** — bypasses 10K truncation, returns full requested range:

| Format | Param | Response extras |
|--------|-------|----------------|
| PDF    | `pages="1-10"` | `pagination.total_pages` |
| PPTX   | `pages="1-20"` | `pagination.total_slides` |
| XLSX   | `sheet="Name"` | `pagination.sheet_names`, `total_sheets` |
| DOCX/text | `offset=0, limit=200` | `pagination.total_lines`, `truncated`, `next_offset` |

For XLSX: read without `sheet` first to get `sheet_names`, then target each sheet by name.
For DOCX/text: use `next_offset` from the response to paginate through the full document.

### raw_versions

List all versions of a raw file.

```json
{
  "filename": "(required) string — Base filename (e.g. 'report.xlsx')"
}
```

Returns: `{ versions: [...], latest: "filename", count: N }`

### raw_coverage

Report which raw/ files are not yet covered by any wiki page.

```json
{
  "limit": "number — Max uncovered entries (default: 50)",
  "sort":  "string — newest | oldest | largest (default: newest)",
  "tag":   "string — Only consider files with this tag"
}
```

Returns: `{ uncovered: [...], covered: N, total: N, coverageRatio: N }`

---

## WIKI LAYER

### wiki_read

Read a wiki page (frontmatter + markdown body).

```json
{
  "page": "string — Path relative to wiki/ (use for single-page reads)",
  "pages": "string array — Paths for multi-page reads (returns array of results)",
  "section": "string — Heading to read (e.g. '## Installation'). Case-insensitive partial match.",
  "offset": "number — First line to return (default: 0). For line-based pagination.",
  "limit":  "number — Max lines (default: 200, max: 500)."
}
```

Either `page` or `pages` is required. Large pages (>200 lines) return paginated JSON with `toc`.

### wiki_write

Create or update a wiki page. Auto-classifies type/tags if missing. Auto-routes to topic subdirectories.

```json
{
  "page": "(required) string — Path relative to wiki/",
  "content": "(required) string — Full content with YAML frontmatter + Markdown body",
  "source": "string — Provenance note (why this write happened)",
  "return_content": "boolean — Include final written content in response. Default: false."
}
```

Returns: `{ ok, page, routed, autoClassified: { type, tags, confidence }, autoLinked, content? }`

Content format:
```markdown
---
title: Page Title
type: concept
tags: [tag1, tag2]
sources: [raw/source-file.pdf]
---

# Page Title

Markdown body here...
```

Valid types: person, concept, event, artifact, code, comparison, summary, how-to, note, synthesis

### wiki_delete

Delete a wiki page.

```json
{
  "page": "(required) string — Path relative to wiki/"
}
```

Cannot delete system pages: index.md, log.md, timeline.md, */index.md

### wiki_list

List wiki pages with optional filters.

```json
{
  "type": "string — Filter by entity type (person|concept|event|artifact|code|comparison|summary|how-to|note|synthesis)",
  "tag": "string — Filter by tag"
}
```

Returns: `{ pages: [...], count: N }`

### wiki_search

Full-text BM25 keyword search. Optionally reads top results in one call.

```json
{
  "query":   "(required) string — Search keywords",
  "limit":   "number — Max results (default: 10)",
  "type":    "string — Filter by entity type",
  "tags":    "string array — Filter by tags (any match)",
  "include_content": "boolean — Inline page content in results. Default: false.",
  "inline_budget":   "number — Max total chars of inlined content (with include_content). Omit for no limit.",
  "read_top_n":   "number — Read top N unique matching pages (max: 10). Activates combined search+read mode.",
  "section":      "string — Section heading filter applied to read pages (with read_top_n).",
  "per_page_limit":"number — Max lines per read page (default: 200, max: 500) (with read_top_n).",
  "include_toc":  "boolean — Include TOC for truncated pages (default: false) (with read_top_n)."
}
```

**Without `read_top_n`:** Returns `{ results: [{ path, score, snippet, section? }], count: N }`.
When `include_content=true`, each result also includes `content`.

**With `read_top_n`:** Returns `{ results, count, pages: [{ path, content, ... }], pagesRead, nextReads }`.
`pages` contains full content for top N unique matching pages (deduplicated).
`nextReads` lists remaining unique page paths for follow-up reads.

**When no results found:** Returns `knowledge_gap` with `suggested_page`, `suggested_title`, `suggested_type`, `suggested_tags`.

### wiki_admin

Wiki administration and maintenance.

```json
{
  "action": "(required) string — init | config | rebuild | lint",
  "path":       "[init] string — Config root where .agent-wiki.yaml is created (default: '.')",
  "workspace":  "[init] string — Separate data directory for wiki/, raw/, schemas/",
  "apply_fixes":"[lint] boolean — Auto-fix fixable issues (missing frontmatter). Default: false."
}
```

**action: init** — Initialize a new knowledge base. Creates wiki/, raw/, schemas/, .agent-wiki.yaml.
Returns: `{ ok, configRoot, workspace, message }`

**action: config** — Show current workspace configuration.
Returns: `{ configRoot, workspace, wikiDir, rawDir, schemasDir, lint, search, separateWorkspace, schemas }`

**action: rebuild** — Rebuild index.md, timeline.md, code knowledge graphs, and optional vector index.
Returns: `{ ok, message }`

**action: lint** — Run comprehensive health checks: contradictions, orphan pages, broken links, SHA-256 integrity, synthesis integrity.
Returns: `{ pagesChecked, rawChecked, issues: [...], contradictions: [...], fixed, fixedPages }`

---

## KNOWLEDGE INGESTION

### knowledge_ingest

Knowledge ingestion pipeline.

```json
{
  "mode": "(required) string — batch | digest_write",

  "source_path":    "[batch] string — (required) Absolute path to directory or file to ingest",
  "pattern":        "[batch] string — Glob filter for directory (e.g. '*.pdf', '*.{xlsx,docx}')",
  "maxFiles":       "[batch] number — Max files to process (default: 100, max: 1000)",
  "topic":          "[batch] string — Topic name for digest packs (default: 'general')",
  "chunkLines":     "[batch] number — Max lines per chunk (default: 100)",
  "packLines":      "[batch] number — Max lines per digest pack (default: 500)",
  "continueOnError":"[batch] boolean — Continue on individual file errors (default: true)",

  "pages": "[digest_write] array — (required) Wiki pages to write. Each: { page, title, body, type?, tags?, topic?, sources?, sourcePacks? }"
}
```

**mode: batch** — Imports files into raw/, extracts text, chunks, and packs into digest packs under raw/digest-packs/{topic}/.
Returns: `{ ok, matched, imported, skipped, extracted, chunks, packs, failed, packPaths, nextRecommendedReads }`

**mode: digest_write** — Writes LLM-generated digest summaries to wiki with provenance. Auto-classifies, auto-routes, auto-timestamps.
Returns: `{ results: [...], count, written }`

---

## CODE ANALYSIS

### code_parse

Parse source file into structured knowledge.

```json
{
  "path": "(required) string — Path in raw/ (e.g. 'PAYROLL.cbl')",
  "trace_variable": "string — Optional variable name to trace"
}
```

Supported: COBOL (.cbl, .cob, .cpy)

Outputs:
- `raw/parsed/<lang>/<stem>.ast.json` — Language-specific AST
- `raw/parsed/<lang>/<stem>.normalized.json` — Language-agnostic model
- `raw/parsed/<lang>/<stem>.summary.json` — Summary
- `raw/parsed/<lang>/<stem>.model.json` — Language-specific model (if available)
- Auto-generated wiki pages

Returns: `{ summary, normalizedModel, artifacts, wikiPages, variableTrace? }`

### code_query

Query parsed code knowledge.

```json
{
  "query_type": "(required) string — trace_variable | impact | procedure_flow | field_lineage | dataflow_edges",

  "path":          "[trace_variable/procedure_flow/dataflow_edges] string — (required) Path in raw/ (e.g. 'PAYROLL.cbl')",
  "variable":      "[trace_variable] string — (required) Variable name (e.g. 'WS-TOTAL-SALARY')",

  "node_id":       "[impact] string — (required) Canonical node ID or logical name (e.g. 'copybook:DATE-UTILS')",
  "kind":          "[impact] string — Node kind: program | copybook | dataset | job | step",
  "max_depth":     "[impact/dataflow_edges] number — Max traversal depth (default: 10)",
  "language":      "[impact/field_lineage] string — Language plugin to use (default: 'cobol')",

  "procedure":     "[procedure_flow] string — Optional procedure/section/paragraph name to focus traversal from",
  "procedure_kind":"[procedure_flow] string — Optional kind filter: section | paragraph",

  "field_name":    "[field_lineage] string — Field name to query (e.g. 'CUSTOMER-ID')",
  "qualified_name":"[field_lineage] string — Optional qualified field path (e.g. 'CUSTOMER-REC.CUSTOMER-ID')",
  "copybook":      "[field_lineage] string — Optional copybook canonical id or logical name",

  "from":          "[dataflow_edges] string — Filter: only edges whose source field matches",
  "to":            "[dataflow_edges] string — Filter: only edges whose target field matches",
  "field":         "[dataflow_edges] string — Starting field for transitive traversal (requires transitive: true)",
  "transitive":    "[dataflow_edges] boolean — Follow edges transitively from `field` (default: false)",
  "direction":     "[dataflow_edges] string — downstream | upstream | both (default: downstream)"
}
```

**query_type: trace_variable** — Traces all references to a variable in a parsed source file.
Returns: `{ variable, file, references: [...] }`

**query_type: impact** — Queries the compiled knowledge graph for downstream impact. Requires compiled knowledge-graph artifact (run `code_parse` on COBOL files first).
Returns: `{ query, source, summary, impactedByDepth: [...], diagnostics }`

**query_type: procedure_flow** — Returns section/paragraph PERFORM flow for one source file.
Returns: `{ path, procedure?, flow: [...] }`

**query_type: field_lineage** — Queries compiled cross-file field lineage. Requires `field-lineage.json` artifact — built by parsing BOTH `.cbl`/`.cob` program files AND `.cpy` copybook files.
Returns: `{ query, summary, deterministic: [...], inferredHighConfidence: [...], inferredAmbiguous: [...] }`

**query_type: dataflow_edges** — Queries MOVE/COMPUTE/SQL/CALL dataflow edges for one source file. Pass `field + transitive: true` to follow chains. Requires `path`.
Returns (non-transitive): `{ file, total, edges: [...] }`
Returns (transitive): `{ file, field, direction, transitive, total_fields, total_edges, levels: [...] }`

---

## BATCH

### batch

Execute multiple tool calls in one request.

```json
{
  "operations": "(required) array — [{ tool: string, args?: object }, ...]"
}
```

Supports any combination of tools. Max 50 operations. wiki_rebuild / wiki_admin action:rebuild are deduplicated (runs once at end). Failures per-operation do not abort the batch.

Returns: `{ results: [{ tool, result? | error? }], count: N }`
