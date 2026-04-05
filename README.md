# agent-wiki

[![npm](https://img.shields.io/npm/v/@agent-wiki/mcp-server)](https://www.npmjs.com/package/@agent-wiki/mcp-server)
[![CI](https://github.com/xinhuagu/agent-wiki/actions/workflows/ci.yml/badge.svg)](https://github.com/xinhuagu/agent-wiki/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/protocol-MCP-blue)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

A structured knowledge base that any AI agent can read, write, and maintain through the [Model Context Protocol](https://modelcontextprotocol.io). No LLM built in — your agent IS the intelligence.

```
npx @agent-wiki/mcp-server serve --wiki-path ./my-knowledge
```

---

## Why

Most AI systems treat knowledge as disposable. You ask a question, it retrieves some fragments, generates an answer, and everything is forgotten. Next time, it starts from zero.

agent-wiki takes a different approach: **knowledge compilation**, a concept introduced by [Andrej Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Instead of retrieving raw documents every time (RAG), the agent incrementally builds and maintains a persistent wiki — structured, interlinked, and continuously refined. Every interaction makes the knowledge base better.

The key insight: **LLMs are better editors than search engines.** Let them curate, synthesize, and maintain knowledge over time — not just retrieve it on demand.

### RAG vs Knowledge Compilation

| | RAG | agent-wiki |
|---|---|---|
| **Approach** | Retrieve fragments at query time | Build and maintain compiled knowledge |
| **Memory** | Stateless — forgets after each query | Persistent — knowledge accumulates |
| **Quality** | Raw chunks, often noisy | Curated, structured, interlinked |
| **Cost** | Embedding + retrieval every query | One-time compilation, free reads |
| **Contradictions** | Invisible — buried in source docs | Surface-level conflicts flagged by lint (dates, numbers) |
| **Source tracking** | Lost after retrieval | Full provenance chain (raw → wiki) |

## Architecture

Three immutability layers, inspired by how compilers work:

| Layer | Mutability | Role |
|-------|-----------|------|
| **raw/** | Immutable | Source documents — write-once, SHA-256 verified. Papers, articles, web pages. |
| **wiki/** | Mutable | Compiled knowledge — structured Markdown pages that improve over time. |
| **schemas/** | Reference | Entity templates — consistent structure across 9 knowledge types. |

The agent reads from `raw/`, compiles understanding into `wiki/`, and the lint engine ensures quality:

<p align="center">
  <img src="architecture.svg" alt="agent-wiki architecture" width="700" />
</p>

## Quick Start

### Claude Code / AceClaw

```json
{
  "mcpServers": {
    "agent-wiki": {
      "command": "npx",
      "args": ["-y", "@agent-wiki/mcp-server", "serve", "--wiki-path", "/path/to/knowledge"]
    }
  }
}
```

### Cursor / Windsurf / any MCP client

Same pattern — point your MCP config to:

```
npx -y @agent-wiki/mcp-server serve --wiki-path /path/to/knowledge
```

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agent-wiki": {
      "command": "npx",
      "args": ["-y", "@agent-wiki/mcp-server", "serve", "--wiki-path", "/path/to/knowledge"]
    }
  }
}
```

### Workspace Separation

Code and data live in separate directories. The tool is stateless — all state lives in the workspace:

```
npx @agent-wiki/mcp-server serve --wiki-path ./config --workspace ./data
```

Resolution priority: CLI `--workspace` > `AGENT_WIKI_WORKSPACE` env > config file > config root.

## Features

### Immutable Source Layer (raw/)

- **Write-once** — raw files can never be modified or overwritten after creation
- **SHA-256 integrity** — every file is hashed; corruption or tampering is detected on `raw_verify`
- **Provenance tracking** — `.meta.yaml` sidecars record source URL, download time, description
- **URL fetching** — `raw_fetch` downloads from URLs with smart arXiv handling (`arxiv.org/abs/XXXX` auto-converts to PDF)
- **80+ MIME types** — documents, images, audio, video, code, data files — any downloadable resource
- **Local file copy** — `raw_add` with `source_path` physically copies files into `raw/` (workspace-scoped by default)

### Atlassian Integration

- **Confluence import** — `raw_import_confluence` fetches a page and optionally all child pages recursively, preserving hierarchy in `_tree.yaml`
- **Jira import** — `raw_import_jira` fetches an issue with full details: fields, description, comments, attachments, and linked issues (rendered as JSON + Markdown)
- **Auth via env vars** — `CONFLUENCE_API_TOKEN` and `JIRA_API_TOKEN` (format: `email:api-token`), never passed as tool arguments
- **Host allowlist** — configurable `atlassian.allowed_hosts` prevents SSRF to arbitrary instances
- **Recursion limits** — `max_pages` (default 100), `link_depth` (default 1), `max_attachment_size` (default 10 MB)

### Compiled Knowledge Layer (wiki/)

- **Structured Markdown** — YAML frontmatter (title, type, tags, sources) + Markdown body
- **9 entity types** — person, concept, event, artifact, comparison, summary, how-to, note, synthesis
- **Auto-classification** — heuristic classifier assigns entity type and suggests tags (zero LLM, zero latency)
- **Wiki-links** — `[[page]]` syntax to interlink pages and build a knowledge graph
- **Synthesis** — distill higher-order knowledge by combining multiple pages
- **Auto-timestamps** — `created` and `updated` managed automatically
- **System pages** — index.md, log.md, timeline.md maintained by the engine

### Self-Checking Lint Engine

The lint system catches common problems automatically:

- **Contradictions** — detects conflicting dates and numeric claims across pages (regex + local-context heuristic — useful for catching obvious conflicts, not a substitute for human review)
- **Orphan pages** — pages with no incoming links
- **Broken links** — `[[page]]` references to non-existent pages
- **Missing sources** — wiki claims not traceable to raw documents
- **Stale content** — pages not updated beyond a configurable threshold
- **Raw integrity** — SHA-256 re-verification of all source files
- **Synthesis integrity** — checks that source pages still exist

### Auto-Classification

Every `wiki_write` automatically classifies content if no type is specified:

```
Input:  "# YOLO Object Detection\n\nYOLO is a real-time detection model..."
Output: { type: "concept", tags: ["yolo", "object-detection", "real-time"], confidence: 0.8 }
```

Pure heuristic — no LLM calls, no API keys, zero latency. Supports English and Chinese.

## Security

- **Directory traversal protection** — all user-supplied page/filename paths go through `safePath()`, which rejects `../`, absolute paths, and null bytes
- **Source path restriction** — `raw_add` with `source_path` is restricted to workspace directory by default; configurable via `security.allowed_source_dirs`
- **Atlassian host allowlist** — `atlassian.allowed_hosts` prevents SSRF; requests to non-listed hosts are rejected
- **No secrets in code** — auth tokens are read from environment variables only

## MCP Tools (21)

### Raw Layer — Immutable Sources

| Tool | Description |
|------|-------------|
| `raw_add` | Add a source document (content string or local file copy, SHA-256 hashed, .meta.yaml sidecar) |
| `raw_fetch` | Download from URL to raw/ (smart arXiv handling, auto-provenance) |
| `raw_list` | List all raw documents with metadata (path, source URL, hash, size) |
| `raw_read` | Read a raw document — text/SVG return content; PDF/DOCX/XLSX/PPTX extracted via Python preprocessor; other binary files return metadata only |
| `raw_verify` | Verify integrity of all raw files via SHA-256 re-check |

### Atlassian — Confluence & Jira

| Tool | Description |
|------|-------------|
| `raw_import_confluence` | Import a Confluence page (+ child pages recursively) into raw/. Preserves hierarchy in `_tree.yaml`. Requires `CONFLUENCE_API_TOKEN` env var. |
| `raw_import_jira` | Import a Jira issue with fields, description, comments, attachments, and linked issues. Saves JSON + Markdown. Requires `JIRA_API_TOKEN` env var. |

### Wiki Layer — Compiled Knowledge

| Tool | Description |
|------|-------------|
| `wiki_read` | Read a page (frontmatter + Markdown) |
| `wiki_write` | Create or update a page (auto-timestamps, auto-classify) |
| `wiki_delete` | Delete a page (guards system pages) |
| `wiki_list` | List pages, filter by entity type or tag |
| `wiki_search` | Full-text keyword search with relevance scoring and snippets |
| `wiki_classify` | Auto-classify content into entity type + suggest tags |
| `wiki_synthesize` | Prepare context for knowledge distillation across multiple pages |
| `wiki_lint` | Health checks: contradictions, orphans, broken links, integrity |
| `wiki_log` | View operation history with timestamps |
| `wiki_init` | Initialize a new knowledge base (creates wiki/, raw/, schemas/) |
| `wiki_config` | Show current workspace configuration and paths |
| `wiki_schemas` | List available entity templates |
| `wiki_rebuild_index` | Rebuild index.md organized by type with counts |
| `wiki_rebuild_timeline` | Rebuild timeline.md as a chronological view |

## Entity Types

| Type | Use Case | Example |
|------|----------|---------|
| `person` | People profiles | Researchers, engineers, historical figures |
| `concept` | Ideas and definitions | YOLO, attention mechanism, GIL |
| `event` | Things that happened | Conference talks, releases, incidents |
| `artifact` | Created things | Papers, tools, models, datasets |
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

## Configuration

`.agent-wiki.yaml`:

```yaml
# Workspace separation (optional)
workspace: ./data

# Atlassian integration (optional)
atlassian:
  allowed_hosts:
    - your-company.atlassian.net
  max_pages: 100                  # Confluence recursion limit
  max_attachment_size: 10485760   # 10 MB max per Jira attachment

# Security (optional)
security:
  allowed_source_dirs:            # restrict raw_add source_path
    - /home/user/documents        # absolute path
    - ../shared-data              # relative to config root
```

Environment variables for Atlassian:

```bash
export CONFLUENCE_API_TOKEN="email@company.com:your-api-token"
export JIRA_API_TOKEN="email@company.com:your-api-token"
```

## CLI

```bash
npx @agent-wiki/mcp-server serve                     # start MCP server (stdio)
npx @agent-wiki/mcp-server serve --workspace ./data   # separate data directory
npx @agent-wiki/mcp-server init ./my-kb               # initialize new knowledge base
npx @agent-wiki/mcp-server search "yolo"              # search wiki
npx @agent-wiki/mcp-server list                       # list all pages
npx @agent-wiki/mcp-server list --type concept        # filter by type
npx @agent-wiki/mcp-server raw-list                   # list raw sources
npx @agent-wiki/mcp-server raw-verify                 # verify raw file integrity
npx @agent-wiki/mcp-server lint                       # run health checks
```

## Design Principles

1. **Raw is immutable** — Source documents are write-once, SHA-256 verified. The ground truth never changes.
2. **Wiki is mutable** — Compiled knowledge improves with every interaction. Pages are refined, not replaced.
3. **No LLM dependency** — Zero API keys, zero cost per operation. The agent calling the tools IS the intelligence.
4. **Self-checking** — Lint catches structural issues (broken links, orphans, stale pages) and flags potential contradictions via heuristic pattern matching. Semantic review still benefits from human or LLM judgment.
5. **Knowledge compounds** — Every write enriches the whole wiki. Synthesis creates higher-order understanding.
6. **Provenance matters** — Every wiki claim traces back to raw sources. No hallucination without accountability.
7. **Code and data separate** — Configurable workspace keeps your knowledge portable and independent.
8. **Git-native** — Plain Markdown files. Every change is diffable, blameable, and revertable.

## Acknowledgments

The knowledge compilation architecture is inspired by Andrej Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) concept — the idea that LLMs should compile and maintain structured knowledge rather than retrieve raw fragments on every query.

## License

MIT
