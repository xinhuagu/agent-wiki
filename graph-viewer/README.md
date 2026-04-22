# @agent-wiki/graph-viewer

Standalone realtime 3D knowledge graph viewer for an agent-wiki workspace.
Edit a `.md` file — the graph updates live.

## Zero coupling with core

This package is **physically and functionally independent** from
`@agent-wiki/mcp-server`:

- Core `agent-wiki` does not import, require, or depend on this package.
- This package reads a wiki directory as plain Markdown (frontmatter +
  `[[wikilinks]]`).
- Removing the `graph-viewer/` directory leaves core MCP / CLI / search / lint
  / raw behavior unchanged.
- Heavy rendering libraries (`3d-force-graph`, `three.js`) are loaded in the
  browser from a CDN and never ship with the core server.

## Quick start

After publishing, three equivalent ways to launch:

```bash
# 1. Through the core CLI (thin handoff — installs nothing in core, resolves
#    and spawns this package at runtime). Needs both packages installed.
npm install -g @agent-wiki/mcp-server @agent-wiki/graph-viewer
agent-wiki web --wiki-path ./wiki --open

# 2. Standalone binary, after installing this package:
npm install -g @agent-wiki/graph-viewer
agent-wiki-graph -w ./wiki

# 3. Zero install:
npx @agent-wiki/graph-viewer --wiki-path /path/to/wiki --open
```

From this repo before publishing, once the package is built:

```bash
node graph-viewer/dist/cli.js -w ./wiki --port 4711 --open
```

Then open http://localhost:4711. Editing any Markdown file under the wiki
directory pushes an incremental graph update over SSE.

### CLI flags

| flag | alias | default | description |
| --- | --- | --- | --- |
| `--wiki-path <dir>` | `-w` | — (required) | path to the wiki directory |
| `--port <n>` | `-p` | `4711` | HTTP port |
| `--host <host>` | | `127.0.0.1` | bind host |
| `--open` | | off | open the browser on startup |
| `--help` | `-h` | | show help |

## Visual language

- **Nodes** are small pastel dots — one per `.md` page. Size grows gently with
  degree. Color is deterministic from topic (first-level directory), primary
  tag, or frontmatter `type`, selectable in the top bar.
- **Index hubs** (`index.md` at root or any `topic/index.md`) render about 2×
  the size of regular pages with a brighter topic-tinted shade so each topic
  cluster has a visible anchor. The root index uses a warm-white tone.
- **Links** are GPU hairlines — a quiet network backdrop that never dominates.
  Hovering or clicking a node lifts the 2-hop neighborhood's edges into a soft
  lavender; edges outside the neighborhood are slightly darkened but **not**
  wiped out, so the rest of the graph is still readable.
- **Selection**: clicked node turns bright yellow. Non-neighborhood nodes keep
  their original colors — no screen-wide "gray flash."
- **Broken links** are soft red ghost nodes (a link to a `.md` that doesn't
  exist). **Orphan** pages (no incoming links) are muted grey.
- **Edit pulse**: when SSE pushes a change, every node whose content actually
  changed — plus any new node — flashes cyan for ~1.2 s. Saves surface as
  visual motion where the change happened, not just in the status bar.

## Interactions

| input | effect |
| --- | --- |
| hover a node | highlight its 2-hop neighborhood edges |
| single-click | select + open side panel, **no** camera motion |
| double-click (same node within 400 ms) | `zoomToFit` onto the 2-hop neighborhood |
| drag a node | force simulation responds, node released on drop |
| background click / `Esc` | clear selection |
| toolbar `−` / `+` / `-` / `=` key | zoom out / in |
| toolbar `home` / `f` or `h` key | clear selection and `zoomToFit` the graph |
| search box | filter nodes by title or slug |
| `color by` select | recolor palette by topic / tag / type |
| hide orphans / hide broken | filter toggles |

## Side panel

Clicking a node opens a right-side panel with:

- title, type, topic, tags, sources, degree
- outgoing and incoming link lists (each item is click-to-select)
- resolved absolute file path for the Markdown file, for easy copy/paste

## Status bar

The top-right status reflects the SSE stream:

- `connecting…` — handshake in progress
- `live · N nodes` — steady state
- `live · N nodes (+k)` / `(-k)` — transient, shown for 2.5 s after node
  count changes
- `live · N nodes · updated` — transient, shown when content changed but the
  node count stayed the same
- `disconnected — retrying` — SSE dropped; it retries automatically
- Uncaught errors or module load failures surface here too (red), so a blank
  page never stays silent.

## Architecture

```
wiki dir (*.md)
      │
      ├─ parse.ts       gray-matter + [[link]] regex → ParsedPage[]
      │                 recursive .md walk
      │
      ├─ graph.ts       ParsedPage[] → { nodes, edges }
      │                 slug / basename link resolution
      │                 orphan + broken flags, self-loop drop
      │
      ├─ server.ts      node:http
      │                 GET  /api/graph    current graph JSON
      │                 GET  /api/events   SSE (graph + error channels)
      │                 POST /api/open     resolve page path
      │                 static /*          public/ assets
      │                 fs.watch(recursive) + debounce → rebuild + broadcast
      │
      └─ public/app.js  ES module, imports 3d-force-graph & three from esm.sh
                        force-directed layout + custom pull-to-origin force
                        edit-pulse via rAF, selection highlights, side panel
```

## Development

```bash
cd graph-viewer
npm install
npm run build     # tsc → dist/
npm test          # vitest: parse + graph + http/SSE smoke (19 tests)
npm run dev       # tsc --watch
```

The server disables browser caching (`Cache-Control: no-store`) so editing
`public/app.js` or `public/style.css` is a hard-refresh away — no restart
needed.

## Removal

Delete the `graph-viewer/` directory. Nothing under `src/` in the core
package imports it. Core build, tests, and MCP server behavior are
unaffected.
