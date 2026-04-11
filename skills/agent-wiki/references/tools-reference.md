# Agent Wiki — Tool Parameter Reference

Complete parameter schemas for all 18 tools.

---

## RAW LAYER

### raw_add

Add a raw source document (immutable, SHA-256 verified).

```json
{
  "filename": "(required) string — Filename in raw/ (e.g. 'paper.pdf'). For directory imports, becomes subdirectory prefix.",
  "content": "string — File content as string (for text files). Mutually exclusive with source_path.",
  "source_path": "string — Absolute path to local file or directory to copy. If directory, all files imported recursively.",
  "source_url": "string — Original URL where downloaded from",
  "description": "string — Brief description",
  "tags": ["string array — Tags for categorization"],
  "auto_version": "boolean — If true and file exists, create versioned copy (e.g. report_v2.xlsx). Default: false",
  "pattern": "string — Glob filter for directory imports (e.g. '*.html'). Ignored for single files."
}
```

Either `content` or `source_path` is required (or neither for empty files).
Directory imports return an array of documents. Single image files (<10MB) return inline image.

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
  "pages": "string — Page range for PDFs (e.g. '1-5', '1-3,7-10'). Only for PDFs."
}
```

- Text/SVG: returns full content (truncated at 10K chars)
- PDF/DOCX/XLSX/PPTX: auto-extracted text
- Images (<10MB): returned inline
- Other binary: metadata only

### raw_versions

List all versions of a raw file.

```json
{
  "filename": "(required) string — Base filename (e.g. 'report.xlsx')"
}
```

Returns: `{ versions: [...], latest: "filename", count: N }`

### raw_fetch

Download file from URL into raw/.

```json
{
  "url": "(required) string — URL to download. arXiv abs URLs auto-converted to PDF.",
  "filename": "string — Override filename (auto-inferred if omitted)",
  "description": "string — Brief description",
  "tags": ["string array"]
}
```

### raw_import_confluence

Import Confluence page(s) recursively.

```json
{
  "url": "(required) string — Confluence page URL",
  "recursive": "boolean — Import child pages (default: false)",
  "depth": "number — Max recursion depth (-1 = unlimited, default: 50 if recursive, 0 if not)",
  "auth_env": "string — Env var name for auth (default: CONFLUENCE_API_TOKEN, format: 'email:api-token')"
}
```

Returns: `{ ok, pages, files, tree }`

### raw_import_jira

Import Jira issue with full details.

```json
{
  "url": "(required) string — Jira issue URL (e.g. https://company.atlassian.net/browse/PROJ-123)",
  "include_comments": "boolean — Include comments (default: true)",
  "include_attachments": "boolean — Download attachments (default: true)",
  "include_links": "boolean — Import linked issues (default: true)",
  "link_depth": "number — Levels of linked issues to follow (default: 1)",
  "auth_env": "string — Env var name for auth (default: JIRA_API_TOKEN)"
}
```

Returns: `{ ok, issueKey, summary, files, linkedIssues, importedCount }`

---

## WIKI LAYER

### wiki_read

Read a wiki page (frontmatter + markdown body).

```json
{
  "page": "(required) string — Path relative to wiki/ (e.g. 'concept-gil.md')"
}
```

Returns the full file content as string.

### wiki_write

Create or update a wiki page. Auto-classifies type/tags if missing. Auto-routes to topic subdirectories.

```json
{
  "page": "(required) string — Path relative to wiki/",
  "content": "(required) string — Full content with YAML frontmatter + Markdown body",
  "source": "string — Provenance note (why this write happened)"
}
```

Returns: `{ ok, page, routed, autoClassified: { type, tags, confidence } }`

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

Full-text BM25 keyword search.

```json
{
  "query": "(required) string — Search keywords",
  "limit": "number — Max results (default: 10)"
}
```

Returns: `{ results: [{ path, score, snippet }], count: N }`

Features: field-weighted scoring, synonym expansion, fuzzy matching, prefix matching, CJK support.

### wiki_lint

Comprehensive health checks. No parameters.

```bash
agent-wiki call wiki_lint
```

Checks: contradictions, orphans, broken [[links]], missing sources, stale content, SHA-256 integrity, synthesis integrity.

Returns: `{ pagesChecked, rawChecked, issues: [...], contradictions: [...] }`

### wiki_init

Initialize a new knowledge base.

```json
{
  "path": "string — Config root (default: '.')",
  "workspace": "string — Separate data directory"
}
```

Creates: wiki/, raw/, schemas/, .agent-wiki.yaml

### wiki_config

Show workspace configuration. No parameters.

```bash
agent-wiki call wiki_config
```

Returns: `{ configRoot, workspace, wikiDir, rawDir, schemasDir, lint, separateWorkspace, schemas }`

### wiki_rebuild

Rebuild index.md and timeline.md. No parameters.

```bash
agent-wiki call wiki_rebuild
```

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

### code_trace_variable

Trace variable references in parsed code.

```json
{
  "path": "(required) string — Path in raw/ (e.g. 'PAYROLL.cbl')",
  "variable": "(required) string — Variable name (e.g. 'WS-TOTAL-SALARY')"
}
```

Returns: `{ variable, file, references: [...] }`
