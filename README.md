# agent-wiki

[![CI](https://github.com/xinhuagu/agent-wiki/actions/workflows/ci.yml/badge.svg)](https://github.com/xinhuagu/agent-wiki/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/protocol-MCP-blue)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

A structured knowledge base that any AI agent can read, write, and maintain through the [Model Context Protocol](https://modelcontextprotocol.io). No LLM built in — your agent IS the LLM.

```
npx @agent-wiki/mcp-server
```

---

## The Idea

Most AI systems treat knowledge as disposable. You ask a question, it retrieves some fragments, generates an answer, and everything is forgotten. Next time you ask, it starts from zero.

agent-wiki takes a different approach: **knowledge compilation**. Instead of retrieving raw documents every time (RAG), the agent incrementally builds and maintains a persistent wiki — structured, interlinked, and continuously refined. Every interaction makes the knowledge base smarter.

The key insight: **LLMs are better editors than search engines.** Let them curate, synthesize, and maintain knowledge over time, not just retrieve it on demand.

### RAG vs Knowledge Compilation

| | RAG | agent-wiki |
|---|---|---|
| **Approach** | Retrieve fragments at query time | Build and maintain compiled knowledge |
| **Memory** | Stateless — forgets after each query | Persistent — knowledge accumulates |
| **Quality** | Raw chunks, often noisy | Curated, structured, interlinked |
| **Cost** | Embedding + retrieval every query | One-time compilation, free reads |
| **Contradictions** | Invisible — buried in source docs | Detected automatically by lint |
| **Source tracking** | Lost after retrieval | Full provenance chain (raw -> wiki) |

## Architecture

Three immutability layers, inspired by how compilers work:

```
raw/      Immutable source documents (write-once, SHA-256 verified)
            Papers, articles, web pages — the "source code" of knowledge

wiki/     Mutable compiled knowledge (entity pages, synthesis, index)
            Structured Markdown — the "compiled output"

schemas/  Entity templates (person, concept, event, artifact, ...)
            Consistent structure across all knowledge
```

The agent reads from `raw/`, compiles understanding into `wiki/`, and the lint system ensures quality:

<p align="center">
  <img src="architecture.svg" alt="agent-wiki architecture" width="700" />
</p>

## Key Features

### Immutable Source Layer (`raw/`)

- **Write-once** — raw files can never be modified or overwritten after creation
- **SHA-256 integrity** — every file is hashed; corruption or tampering is detected
- **Provenance tracking** — `.meta.yaml` sidecars record source URL, download time, description
- **URL fetching** — `raw_fetch` downloads directly from URLs, with smart arXiv handling (`arxiv.org/abs/XXXX` auto-converts to PDF)
- **Local file copy** — `raw_add` with `source_path` physically copies files into `raw/`

### Mutable Knowledge Layer (`wiki/`)

- **Structured Markdown** — YAML frontmatter (title, type, tags, sources) + Markdown body
- **9 entity types** — person, concept, event, artifact, comparison, summary, how-to, note, synthesis
- **Auto-classification** — heuristic classifier assigns entity type and suggests tags, zero LLM needed
- **`[[wiki-links]]`** — interlink pages to build a knowledge graph
- **Synthesis pages** — higher-order knowledge distilled from combining multiple pages
- **Auto-timestamps** — `created` and `updated` managed automatically
- **System pages** — index.md, log.md, timeline.md maintained by the engine

### Self-Checking (`lint`)

No human review needed. The lint system catches problems automatically:

- **Contradictions** — conflicting dates, numbers, and claims across pages
- **Orphan pages** — pages with no incoming links
- **Broken links** — `[[page]]` references to non-existent pages
- **Missing sources** — wiki claims not traceable to raw documents
- **Stale content** — pages not updated beyond a configurable threshold
- **Raw integrity** — SHA-256 re-verification of all source files
- **Synthesis integrity** — checks that source pages of synthesis still exist

### Workspace Separation

Code and data live in separate directories. The tool is stateless; all state lives in the workspace:

```yaml
# .agent-wiki.yaml
wiki:
  workspace: /path/to/data    # all data goes here
  path: wiki/
  raw_path: raw/
  schemas_path: schemas/
```

Workspace resolution priority: CLI `--workspace` > `AGENT_WIKI_WORKSPACE` env > config file > config root.

### Auto-Classification

Every `wiki_write` automatically classifies content if no type is specified:

```
Input:  "# YOLO Object Detection\n\nYOLO is a real-time detection model..."
Output: { type: "concept", tags: ["yolo", "object-detection", "real-time"], confidence: 0.8 }
```

Pure heuristic — no LLM calls, no API keys, zero latency. Supports English and Chinese keywords.

## Setup

### Claude Code / AceClaw

`~/.aceclaw/mcp-servers.json`:

```json
{
  "mcpServers": {
    "agent-wiki": {
      "command": "npx",
      "args": ["-y", "agent-wiki", "serve", "--wiki-path", "/path/to/config", "--workspace", "/path/to/data"]
    }
  }
}
```

### Cursor / Windsurf / any MCP client

Same pattern — `npx -y @agent-wiki/mcp-server serve --wiki-path /path/to/config`.

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agent-wiki": {
      "command": "npx",
      "args": ["-y", "agent-wiki", "serve", "--wiki-path", "/path/to/config"]
    }
  }
}
```

## MCP Tools (17 total)

### Raw Layer — Immutable Sources

| Tool | Description |
|------|-------------|
| `raw_add` | Add a source document (immutable, SHA-256 hashed, .meta.yaml sidecar) |
| `raw_fetch` | Download from URL to raw/ (smart arXiv handling, auto-provenance) |
| `raw_list` | List all raw documents with metadata |
| `raw_read` | Read a raw document's content and metadata |
| `raw_verify` | Verify integrity of all raw files (SHA-256 check) |

### Wiki Layer — Compiled Knowledge

| Tool | Description |
|------|-------------|
| `wiki_read` | Read a page (frontmatter + Markdown) |
| `wiki_write` | Create or update a page (auto-timestamps, auto-classify) |
| `wiki_delete` | Delete a page (guards system pages) |
| `wiki_list` | List pages, filter by type or tag |
| `wiki_search` | Full-text keyword search with relevance scoring |
| `wiki_lint` | Health checks: contradictions, orphans, broken links, integrity |
| `wiki_classify` | Auto-classify content into entity type + suggest tags |
| `wiki_synthesize` | Prepare context for knowledge distillation across pages |
| `wiki_log` | Operation history with timestamps |
| `wiki_init` | Initialize a new knowledge base |
| `wiki_schemas` | List entity templates |
| `wiki_rebuild_index` | Rebuild index.md (grouped by type) |
| `wiki_rebuild_timeline` | Rebuild timeline.md (chronological view) |
| `wiki_config` | Show current workspace configuration |

## Entity Types

| Type | Use Case | Example |
|------|----------|---------|
| `person` | People profiles | Researchers, engineers, historical figures |
| `concept` | Ideas and definitions | YOLO, attention mechanism, mutex |
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

## CLI

```bash
npx agent-wiki serve                    # start MCP server (stdio)
npx agent-wiki serve --workspace ./data # separate data directory
npx agent-wiki init ./my-kb             # initialize new knowledge base
npx agent-wiki search "yolo"            # search wiki
npx agent-wiki list                     # list all pages
npx agent-wiki list --type concept      # filter by type
npx agent-wiki raw-list                 # list raw sources
npx agent-wiki raw-verify               # verify raw file integrity
npx agent-wiki lint                     # run health checks
```

## Design Principles

1. **Raw is immutable** — Source documents are write-once, SHA-256 verified. The ground truth never changes.
2. **Wiki is mutable** — Compiled knowledge improves with every interaction. Pages are refined, not replaced.
3. **No LLM dependency** — Zero API keys, zero cost per operation. The agent calling the tools IS the intelligence.
4. **Self-checking** — Lint catches contradictions, broken links, and integrity issues without human review.
5. **Knowledge compounds** — Every write enriches the whole wiki. Synthesis creates higher-order understanding.
6. **Provenance matters** — Every wiki claim traces back to raw sources. No hallucination without accountability.
7. **Code and data separate** — Configurable workspace keeps your knowledge portable and independent.
8. **Git-native** — Plain Markdown files. Every change is diffable, blameable, and revertable.

## License

MIT
