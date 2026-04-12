---
name: agent-wiki
version: "${VERSION}"
description: Manage project wiki - read/write wiki pages, search knowledge base, import from Confluence/Jira, add raw files, parse COBOL code. Use for project documentation, knowledge lookup, and code analysis. Invoke as /agent-wiki [query or action].
argument-hint: <action> e.g. "search GEOS deployment" or "read page overview" or "import confluence page"
context: inline
user-invocable: true
allowedTools: [bash]
---

# Agent Wiki — Knowledge Base Skill

Manage a structured knowledge base with immutable raw sources and a mutable wiki layer.

## Architecture

```
raw/    → Immutable source layer (SHA-256 verified, write-once)
wiki/   → Mutable knowledge layer (Markdown + YAML frontmatter, auto-classified)
schemas/→ Entity templates (person, concept, event, artifact, ...)
```

## How to Call Tools

All 18 tools are invoked via `agent-wiki call`:

```bash
agent-wiki call <tool_name> '<json_args>'
```

Add `-w <path>` if the knowledge base is not in the current directory.

## Wiki Operations

### Search wiki
```bash
agent-wiki call wiki_search '{"query": "deployment config", "limit": 5}'
```

### Read a wiki page
```bash
agent-wiki call wiki_read '{"page": "concept-overview.md"}'
```

### Write/update a wiki page
```bash
agent-wiki call wiki_write '{"page": "concept-x.md", "content": "---\ntitle: Concept X\ntype: concept\ntags: [research]\nsources: [raw/paper.pdf]\n---\n\n# Concept X\n\nKey findings..."}'
```

### List wiki pages
```bash
agent-wiki call wiki_list
agent-wiki call wiki_list '{"type": "concept", "tag": "cobol"}'
```

### Delete a wiki page
```bash
agent-wiki call wiki_delete '{"page": "old-page.md"}'
```

## Raw File Operations

### List raw files
```bash
agent-wiki call raw_list
```

### Read a raw file
```bash
agent-wiki call raw_read '{"filename": "notes.pdf"}'
agent-wiki call raw_read '{"filename": "large.pdf", "pages": "1-5"}'
```

### Add a raw file (from content or local path)
```bash
agent-wiki call raw_add '{"filename": "doc.txt", "content": "file content here"}'
agent-wiki call raw_add '{"filename": "code.cbl", "source_path": "/path/to/file.cbl"}'
```

**IMPORTANT:** When adding COBOL files (.cbl, .cob, .cpy), ALWAYS follow up with `code_parse` immediately to auto-generate AST, normalized model, and wiki pages:
```bash
agent-wiki call raw_add '{"filename": "PAYROLL.cbl", "source_path": "/path/to/PAYROLL.cbl"}'
agent-wiki call code_parse '{"path": "PAYROLL.cbl"}'
```

### Fetch from URL
```bash
agent-wiki call raw_fetch '{"url": "https://example.com/doc.pdf", "description": "Research paper"}'
```

### View file versions
```bash
agent-wiki call raw_versions '{"filename": "report.xlsx"}'
```

## Import Operations

### Import from Confluence
```bash
agent-wiki call raw_import_confluence '{"url": "https://company.atlassian.net/wiki/spaces/ENG/pages/123/Title", "recursive": true, "depth": 2}'
```

### Import from Jira
```bash
agent-wiki call raw_import_jira '{"url": "https://company.atlassian.net/browse/PROJ-123", "include_comments": true}'
```

## Code Analysis

### Import and parse COBOL source
```bash
# Step 1: Add the source file
agent-wiki call raw_add '{"filename": "PAYROLL.cbl", "source_path": "/path/to/PAYROLL.cbl"}'
# Step 2: Parse to generate AST + wiki pages
agent-wiki call code_parse '{"path": "PAYROLL.cbl"}'
```

### Trace variable usage
```bash
agent-wiki call code_trace_variable '{"path": "PAYROLL.cbl", "variable": "WS-TOTAL-SALARY"}'
```

## Admin Operations

```bash
agent-wiki call wiki_rebuild       # Rebuild index.md and timeline.md
agent-wiki call wiki_lint          # Health checks
agent-wiki call wiki_config        # Show workspace config
```

## Request Optimization (CRITICAL)

**ALWAYS minimize the number of tool calls. Each tool call costs one LLM request.**

- **Looking up existing wiki pages?** Use `wiki_search` or `wiki_search_read` — NEVER use multiple `glob` calls to find pages one by one.
- **Reading multiple pages?** Use `wiki_read` with `pages` array, or `wiki_search_read` with `readTopN` — NEVER read pages one at a time.
- **Writing multiple pages?** Use `knowledge_digest_write` or `batch` — NEVER write pages one at a time.
- **Multiple independent operations?** Use `batch` to combine them into one call.
- **Importing files?** Use `knowledge_ingest_batch` for directories — NEVER import files one at a time.

### Batch Operations
```bash
# Read multiple pages in one call
agent-wiki call wiki_read '{"pages": ["concept-a.md", "concept-b.md", "concept-c.md"]}'

# Search + read top results in one call (replaces search → glob → read loop)
agent-wiki call wiki_search_read '{"query": "SORDI Bloomberg", "readTopN": 5}'

# Write multiple digest pages in one call
agent-wiki call knowledge_digest_write '{"pages": [{"page": "summary.md", "title": "Summary", "body": "..."}]}'

# Combine any operations in one call
agent-wiki call batch '{"operations": [{"tool": "wiki_search", "args": {"query": "SWEIO"}}, {"tool": "wiki_read", "args": {"page": "concept-x.md"}}]}'

# Ingest an entire directory in one call
agent-wiki call knowledge_ingest_batch '{"source_path": "/path/to/docs", "topic": "geos"}'
```

## Instructions

Based on $ARGUMENTS:
1. If user asks to search or find: use `wiki_search_read` (returns content inline) or `wiki_search`
2. If user asks to read a page or document: use `wiki_read` (supports `pages` array for multi-read) or `raw_read`
3. If user asks to write or update: use `wiki_write` (single) or `knowledge_digest_write` (multiple with provenance)
4. If user asks to list pages or files: use `wiki_list` or `raw_list`
5. If user asks to import from Confluence/Jira: use `raw_import_confluence` or `raw_import_jira`
6. If user asks to import a directory of files: use `knowledge_ingest_batch`
7. **When adding ANY COBOL file (.cbl, .cob, .cpy) via `raw_add`: ALWAYS run `code_parse` immediately after.** This is mandatory — never add a COBOL file without parsing it.
8. If user asks about code analysis or variables: use `code_parse` or `code_trace_variable`
9. If user asks to check health: use `wiki_lint`
10. **When performing multiple operations, ALWAYS use `batch` to combine them into a single call.**
11. Present results in clear, structured format
12. Most tool outputs are JSON. Exceptions: `wiki_read` returns raw Markdown; missing-page lookups return plain text errors (non-zero exit code)
