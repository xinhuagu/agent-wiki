---
name: agent-wiki
version: "${VERSION}"
description: >
  Manage a structured knowledge base with immutable raw sources and a mutable wiki layer.
  Use this skill whenever the user mentions knowledge base, wiki, raw documents, importing
  documents (Confluence, Jira, URLs, files), searching knowledge, code parsing (COBOL),
  or asks to add/read/write/search/lint knowledge. Also trigger when the user says
  "agent-wiki", "wiki", "knowledge base", "raw sources", "import from confluence",
  "import from jira", "parse COBOL", "trace variable", or any variation. Even if the user
  just says "add this to the wiki", "search for X", or "check the knowledge base", use this skill.
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Agent Wiki — Knowledge Base Skill

You are operating an **agent-wiki** knowledge base. All operations go through the `agent-wiki` CLI.

## Architecture

```
raw/    → Immutable source layer (SHA-256 verified, write-once)
wiki/   → Mutable knowledge layer (Markdown + YAML frontmatter, auto-classified)
schemas/→ Entity templates (person, concept, event, artifact, ...)
```

## How to Call Tools

Every tool is invoked via the CLI `call` command. The binary is `agent-wiki` (or `npx @agent-wiki/mcp-server` if not globally installed).

```bash
agent-wiki call <tool_name> '<json_args>'
```

- Arguments are a **JSON string** with snake_case keys.
- Tools with no required args can omit the JSON: `agent-wiki call wiki_list`
- Add `-w <path>` if the knowledge base is not in the current directory.
- Add `--workspace <path>` if data lives in a separate workspace directory.

### Workspace detection

Before calling any tool, check if `.agent-wiki.yaml` exists in the current directory. If not, find it:

```bash
# Check current directory first
ls .agent-wiki.yaml 2>/dev/null || echo "not found"
```

If not in CWD, use `-w /path/to/config/root` on every call.

## Available Tools (18)

### RAW LAYER — Immutable Source Documents

| Tool | Purpose |
|------|---------|
| `raw_add` | Add a file to raw/ (from content string, local path, or directory) |
| `raw_list` | List all raw documents with metadata |
| `raw_read` | Read a raw document's content and metadata |
| `raw_versions` | List all versions of a raw file |
| `raw_fetch` | Download a file from URL into raw/ |
| `raw_import_confluence` | Import Confluence page(s) recursively |
| `raw_import_jira` | Import Jira issue with comments/attachments/links |

### WIKI LAYER — Mutable Knowledge

| Tool | Purpose |
|------|---------|
| `wiki_read` | Read a wiki page (frontmatter + markdown) |
| `wiki_write` | Create or update a wiki page (auto-classified, auto-routed) |
| `wiki_delete` | Delete a wiki page (cannot delete system pages) |
| `wiki_list` | List wiki pages, optionally filtered by type/tag |
| `wiki_search` | Full-text BM25 search with snippets |
| `wiki_lint` | Health checks: contradictions, orphans, broken links, integrity |
| `wiki_init` | Initialize a new knowledge base |
| `wiki_config` | Show workspace configuration |
| `wiki_rebuild` | Rebuild index.md and timeline.md |

### CODE ANALYSIS

| Tool | Purpose |
|------|---------|
| `code_parse` | Parse source file into AST + normalized model + per-file wiki page; refreshes cross-file lineage and the knowledge graph |
| `code_query` | Unified query surface for parsed code — pick a `query_type`: `trace_variable`, `impact`, `procedure_flow`, `field_lineage`, or `dataflow_edges` |

## Common Workflows

### 1. Import a document and create wiki knowledge

```bash
# Download from URL
agent-wiki call raw_fetch '{"url":"https://example.com/paper.pdf","description":"Research paper on X"}'

# Or add from local file
agent-wiki call raw_add '{"filename":"report.pdf","source_path":"/path/to/report.pdf"}'

# Read the imported content
agent-wiki call raw_read '{"filename":"paper.pdf"}'

# Write a wiki page based on it
agent-wiki call wiki_write '{"page":"concept-x.md","content":"---\ntitle: Concept X\ntype: concept\ntags: [research]\nsources: [raw/paper.pdf]\n---\n\n# Concept X\n\nKey findings..."}'
```

### 2. Search and update knowledge

```bash
# Search
agent-wiki call wiki_search '{"query":"machine learning"}'

# Read a specific page
agent-wiki call wiki_read '{"page":"concept-x.md"}'

# Update it
agent-wiki call wiki_write '{"page":"concept-x.md","content":"...updated content...","source":"Updated with new findings"}'
```

### 3. Health check

```bash
agent-wiki call wiki_lint
```

### 4. Parse COBOL source code

```bash
# First add the source file
agent-wiki call raw_add '{"filename":"PAYROLL.cbl","source_path":"/path/to/PAYROLL.cbl"}'

# Parse it — generates AST, normalized model, COBOL-specific model,
# per-file wiki page, and refreshes cross-file lineage / system map.
agent-wiki call code_parse '{"path":"PAYROLL.cbl"}'

# Query parsed code (unified surface — pick a query_type)
agent-wiki call code_query '{"query_type":"trace_variable","path":"PAYROLL.cbl","variable":"WS-TOTAL-SALARY"}'
agent-wiki call code_query '{"query_type":"impact","node_id":"copybook:DATE-UTILS"}'
agent-wiki call code_query '{"query_type":"procedure_flow","path":"PAYROLL.cbl"}'
agent-wiki call code_query '{"query_type":"field_lineage","field_name":"CUSTOMER-ID"}'
```

## Writing Wiki Pages with Long Content

For `wiki_write`, the content can be long (full Markdown with frontmatter). Two approaches:

**Approach A — Direct JSON (short content):**
```bash
agent-wiki call wiki_write '{"page":"note-x.md","content":"---\ntitle: X\ntype: note\ntags: []\n---\n\nShort note."}'
```

**Approach B — Write to temp file first (recommended for long content):**
1. Use the Write tool to create a temp file (e.g., `/tmp/wiki-page.md`)
2. Then use `raw_add` + manual copy, or pass it via JSON with escaped content

For multi-line content, use a heredoc to avoid escaping issues:

```bash
agent-wiki call wiki_write "$(cat <<'ENDJSON'
{"page":"concept-x.md","content":"---\ntitle: Concept X\ntype: concept\ntags: [research, ml]\nsources: [raw/paper.pdf]\n---\n\n# Concept X\n\nThis is a detailed page about Concept X.\n\n## Key Points\n\n- Point 1\n- Point 2\n"}
ENDJSON
)"
```

## Important Notes

- **COBOL auto-parse**: When adding ANY COBOL file (.cbl, .cob, .cpy) via `raw_add`, you MUST ALWAYS immediately run `code_parse` on it. This is mandatory — never add a COBOL file without parsing it. The parse generates AST, normalized model, and auto-creates wiki pages.
- **Raw files are immutable** — once added, they cannot be modified. Use `raw_versions` + `auto_version` for updates.
- **Wiki pages are mutable** — they represent compiled knowledge that improves over time.
- **Auto-classification**: `wiki_write` automatically infers `type` and `tags` if missing from frontmatter.
- **Auto-routing**: Root-level pages are automatically routed to matching topic subdirectories.
- **System pages** (`index.md`, `log.md`, `timeline.md`, `*/index.md`) cannot be deleted.
- **Lint regularly** — `wiki_lint` catches contradictions, orphans, broken links, and integrity issues.
- Most tool outputs are **JSON** (e.g. `wiki_list`, `wiki_search`, `raw_add`). Exceptions: `wiki_read` returns raw Markdown content; missing-page lookups return plain text error messages.

## Error Handling

If a command fails, it exits with code 1 and prints an error. Always check the exit code:

```bash
agent-wiki call wiki_read '{"page":"nonexistent.md"}' || echo "Page not found"
```

## Full Parameter Reference

For detailed parameter schemas of each tool, read the reference file:
`skills/agent-wiki/references/tools-reference.md`
