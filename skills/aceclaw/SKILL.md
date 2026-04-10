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

## Instructions

Based on $ARGUMENTS:
1. If user asks to search or find: use `wiki_search`
2. If user asks to read a page or document: use `wiki_read` or `raw_read`
3. If user asks to write or update: use `wiki_write`
4. If user asks to list pages or files: use `wiki_list` or `raw_list`
5. If user asks to import from Confluence/Jira: use `raw_import_confluence` or `raw_import_jira`
6. **When adding ANY COBOL file (.cbl, .cob, .cpy) via `raw_add`: ALWAYS run `code_parse` immediately after.** This is mandatory — never add a COBOL file without parsing it.
7. If user asks about code analysis or variables: use `code_parse` or `code_trace_variable`
8. If user asks to check health: use `wiki_lint`
9. Present results in clear, structured format
10. All tool outputs are JSON — parse them to check status or extract data
