# agent-wiki

Structured Markdown knowledge base with MCP server. No LLM built in — your agent IS the LLM.

```
npx agent-wiki
```

## What is this?

A wiki engine implementing the "knowledge compilation" pattern — instead of retrieving fragments on every query (RAG), the agent incrementally builds and maintains a persistent wiki of compiled knowledge.

Three layers:

```
raw/     Immutable sources (downloaded files, write-once, SHA-256 verified)
wiki/    Mutable knowledge (entity pages, synthesis pages, index, log, timeline)
schemas/ Entity templates (person, concept, event, artifact, synthesis, ...)
```

```
┌─────────────────────────────────────┐
│  Your Agent (Claude, GPT, etc.)     │
│         │                           │
│         │ MCP (stdio)               │
│         ▼                           │
│  ┌─────────────────────────┐        │
│  │     agent-wiki           │        │
│  │                          │        │
│  │  RAW (immutable)         │        │
│  │    raw_add / raw_read    │        │
│  │    raw_list / raw_verify │        │
│  │                          │        │
│  │  WIKI (mutable)          │        │
│  │    read / write / delete │        │
│  │    search / lint         │        │
│  │    synthesize            │        │
│  │    rebuild_index         │        │
│  │    rebuild_timeline      │        │
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

### Cursor / Windsurf / any MCP client

Same pattern — `npx -y agent-wiki serve --wiki-path /path/to/my-kb`.

## MCP Tools

### Raw Layer (Immutable)

| Tool | Description |
|------|-------------|
| `raw_add` | Add a source document (immutable, SHA-256 hashed, with .meta.yaml sidecar) |
| `raw_list` | List all raw documents with metadata |
| `raw_read` | Read a raw document's content and metadata |
| `raw_verify` | Verify integrity of all raw files (SHA-256 check) |

### Wiki Layer (Mutable)

| Tool | Description |
|------|-------------|
| `wiki_read` | Read a page (frontmatter + Markdown) |
| `wiki_write` | Create or update a page (auto-timestamps) |
| `wiki_delete` | Delete a page (guards system pages) |
| `wiki_list` | List pages, filter by type or tag |
| `wiki_search` | Keyword search with relevance scoring |
| `wiki_lint` | Health checks: contradictions, orphans, broken links, integrity |
| `wiki_log` | Operation history with timestamps |
| `wiki_init` | Initialize a new knowledge base |
| `wiki_schemas` | List entity templates |
| `wiki_rebuild_index` | Rebuild index.md (grouped by type with counts) |
| `wiki_rebuild_timeline` | Rebuild timeline.md (chronological view) |
| `wiki_synthesize` | Prepare context for knowledge distillation across pages |

## Self-Checking (Lint)

The lint system detects problems without needing an LLM:

- **Contradictions** — Detects conflicting dates, numbers, and claims across pages
- **Orphan pages** — Pages with no incoming links
- **Broken links** — `[[page]]` references to non-existent pages
- **Missing sources** — Claims not traceable to raw documents
- **Stale content** — Pages not updated beyond a configurable threshold
- **Raw integrity** — SHA-256 verification of immutable source files
- **Synthesis integrity** — Checks that source pages of synthesis still exist

## Entity Types

| Type | Use Case |
|------|----------|
| `person` | People profiles |
| `concept` | Ideas, theories, definitions |
| `event` | Things that happened |
| `artifact` | Tools, papers, products |
| `comparison` | Side-by-side analysis |
| `summary` | Document summaries |
| `how-to` | Procedures and guides |
| `note` | Anything freeform |
| `synthesis` | Distilled knowledge from multiple pages |

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

Synthesis pages add `derived_from`:

```markdown
---
title: Object Detection Overview
type: synthesis
derived_from: [concept-yolo.md, concept-ssd.md, concept-rcnn.md]
---
```

## Design Principles

1. **Raw is immutable** — Source documents never change. SHA-256 verified.
2. **Wiki is mutable** — Compiled knowledge improves over time.
3. **No LLM dependency** — Zero API keys, zero cost per operation.
4. **Self-checking** — Lint catches contradictions, broken links, integrity issues.
5. **Knowledge compounds** — Every write enriches the whole wiki.
6. **Git is version control** — Every change is diffable, blameable, revertable.

## License

MIT
