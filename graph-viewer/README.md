# @agent-wiki/graph-viewer

Standalone realtime 3D knowledge graph viewer for an agent-wiki workspace.

This package is **physically and functionally independent** from `@agent-wiki/mcp-server`:

- Core `agent-wiki` does not import, require, or depend on this package.
- This package reads a wiki directory as plain Markdown (frontmatter + `[[wikilinks]]`).
- Removing this package leaves core MCP/CLI/search/lint/raw behavior unchanged.
- Heavy rendering libraries (`3d-force-graph`, Three.js) are loaded in the browser
  from a CDN and never ship with the core server.

## Usage

```bash
npx @agent-wiki/graph-viewer --wiki-path /path/to/wiki
```

Or as an alias via `agent-wiki web` style UX:

```bash
agent-wiki-graph --wiki-path ./wiki --port 4711 --open
```

Then open http://localhost:4711 — editing any Markdown file pushes a live graph
update over SSE.

## What it shows

- Each `.md` page is a node. Color by topic (first-level directory), primary
  tag, or frontmatter `type`. Size reflects degree.
- `[[page]]` and `[[page|alias]]` references are edges.
- Broken links render as red ghost nodes. Orphan pages (no incoming edges) are
  muted.

## Architecture

```
wiki dir (*.md)  →  parser (gray-matter + [[link]] regex)
                 →  graph builder (nodes/edges, broken/orphan flags)
                 →  HTTP server (GET /api/graph, GET /api/events SSE)
                 →  browser (3d-force-graph via CDN)

fs.watch(wikiDir) → debounce → rebuild → broadcast "graph" SSE event
```

## Install removal

Delete the `graph-viewer/` directory. Nothing in `src/` imports it.
