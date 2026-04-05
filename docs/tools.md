# MCP Tools Reference

agent-wiki exposes 21 tools through the Model Context Protocol.

## Raw Layer — Immutable Sources

| Tool | Description |
|------|-------------|
| `raw_add` | Add a source document (content string, local file, or entire directory). SHA-256 hashed with `.meta.yaml` sidecar. Supports `auto_version` for same-name files and `pattern` filtering for directories. |
| `raw_fetch` | Download from URL to raw/ (smart arXiv handling — `arxiv.org/abs/XXXX` auto-converts to PDF) |
| `raw_list` | List all raw documents with metadata (path, source URL, hash, size) |
| `raw_read` | Read a raw document — text/SVG return content; PDF/DOCX/XLSX/PPTX extracted via Python preprocessor; other binary return metadata only |
| `raw_verify` | Verify integrity of all raw files via SHA-256 re-check |
| `raw_versions` | List all versions of a file with metadata, returns latest version |

## Atlassian — Confluence & Jira

| Tool | Description |
|------|-------------|
| `raw_import_confluence` | Import a Confluence page (+ child pages recursively) into raw/. Preserves hierarchy in `_tree.yaml`. Requires `CONFLUENCE_API_TOKEN` env var. |
| `raw_import_jira` | Import a Jira issue with fields, description, comments, attachments, and linked issues. Saves JSON + Markdown. Requires `JIRA_API_TOKEN` env var. |

## Wiki Layer — Compiled Knowledge

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

## Auto-Classification

Every `wiki_write` automatically classifies content if no type is specified:

```
Input:  "# YOLO Object Detection\n\nYOLO is a real-time detection model..."
Output: { type: "concept", tags: ["yolo", "object-detection", "real-time"], confidence: 0.8 }
```

Pure heuristic — no LLM calls, no API keys, zero latency. Supports English and Chinese.
