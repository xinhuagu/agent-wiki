# agent-wiki

Structured Markdown knowledge base with MCP server. No LLM built in — your agent IS the LLM.

```
npx agent-wiki
```

## What is this?

A wiki engine that stores knowledge as interlinked Markdown pages with YAML frontmatter. It exposes all operations (read, write, search, lint, etc.) as MCP tools that any AI agent can call.

Unlike traditional "smart" knowledge bases that bundle their own LLM, agent-wiki is a **pure data layer**. The calling agent does all the thinking — classification, summarization, cross-referencing. This is simpler, cheaper, and works with any LLM provider.

```
┌─────────────────────────────────────┐
│  Your Agent (Claude, GPT, etc.)     │  ← The LLM lives here
│         │                           │
│         │ MCP (stdio)               │
│         ▼                           │
│  ┌─────────────────────────┐        │
│  │     agent-wiki          │        │  ← Pure data operations
│  │  read / write / search  │        │
│  │  lint / schemas / log   │        │
│  │         │               │        │
│  │         ▼               │        │
│  │  wiki/  (Markdown)      │        │
│  │  raw/   (source docs)   │        │
│  │  schemas/ (templates)   │        │
│  └─────────────────────────┘        │
└─────────────────────────────────────┘
```

## Setup

Add to your agent's MCP config:

### Claude Code / AceClaw

`~/.aceclaw/mcp-servers.json`:

```json
{
  "mcpServers": {
    "agent-wiki": {
      "command": "npx",
      "args": ["-y", "agent-wiki", "serve", "--wiki-path", "/path/to/my-kb"]
    }
  }
}
```

### Cursor

Settings > MCP Servers:

```json
{
  "agent-wiki": {
    "command": "npx",
    "args": ["-y", "agent-wiki", "serve", "--wiki-path", "/path/to/my-kb"]
  }
}
```

### Windsurf / Continue / any MCP client

Same pattern — `npx -y agent-wiki serve --wiki-path /path/to/my-kb`.

## MCP Tools

| Tool | Description |
|------|-------------|
| `wiki_read` | Read a page (returns frontmatter + Markdown) |
| `wiki_write` | Create or update a page |
| `wiki_delete` | Delete a page |
| `wiki_list` | List pages, optionally filter by type or tag |
| `wiki_search` | Keyword search with relevance scoring and snippets |
| `wiki_lint` | Health checks: orphans, broken links, missing sources, stale content |
| `wiki_log` | Operation history |
| `wiki_init` | Initialize a new knowledge base |
| `wiki_schemas` | List entity templates (person, concept, event, artifact, ...) |
| `wiki_rebuild_index` | Rebuild index.md from all pages |

## Entity Types (Templates)

Schemas are suggestions, not requirements. Pages can use any type or no type at all.

| Type | Use Case |
|------|----------|
| `person` | People profiles |
| `concept` | Ideas, theories, definitions |
| `event` | Things that happened |
| `artifact` | Tools, papers, products |
| `comparison` | Side-by-side analysis |
| `summary` | Document summaries |
| `how-to` | Procedures and guides |
| `note` | Anything that doesn't fit above |

## Page Format

Pages are Markdown with YAML frontmatter:

```markdown
---
title: Python GIL
type: concept
tags: [python, concurrency]
sources: [wikipedia, cpython-docs]
---

# Python GIL

The Global Interpreter Lock prevents true parallelism in CPython.

Related: [[multiprocessing]], [[asyncio]]
```

Cross-references use `[[page-name]]` wiki-link syntax.

## CLI

```bash
npx agent-wiki init ./my-kb          # create a new knowledge base
npx agent-wiki search "python" -w ./my-kb   # keyword search
npx agent-wiki list -w ./my-kb       # list all pages
npx agent-wiki lint -w ./my-kb       # health check
npx agent-wiki serve -w ./my-kb      # start MCP server (default)
```

## Design Principles

1. **No LLM dependency** — Zero API keys, zero cost per operation. Your agent does the thinking.
2. **Plain Markdown** — Human-readable, git-friendly, works with any text editor.
3. **Wiki links** — `[[page]]` cross-references create a knowledge graph.
4. **Schemas are optional** — Templates help structure pages but are never required.
5. **Lint catches problems** — Orphan pages, broken links, stale content, missing sources.
6. **Git is version control** — Every change is diffable, blameable, revertable.

## Why not RAG?

| | RAG | agent-wiki |
|---|---|---|
| How it works | Retrieve chunks per query | Agent compiles knowledge once, reads wiki |
| Knowledge growth | None between queries | Compounds with every write |
| Cross-references | Ad-hoc per query | Pre-built [[links]] |
| Contradiction detection | None | Built into lint |
| Cost per query | Embedding + retrieval + LLM | Just reading files |

## License

MIT
