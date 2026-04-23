// Loaded directly by the browser as an ES module.
// 3d-force-graph is pulled from a CDN so nothing heavy ships with the core server.
import ForceGraph3D from "https://esm.sh/3d-force-graph@1.73.4";

/** Selection color — distinct from the hash-HSL palette (65% sat, 60% lightness). */
const SELECTED_COLOR = "#ffd60a";
/** Edit-pulse color (realtime change feedback). Cyan doesn't collide with yellow selection or red broken. */
const PULSE_COLOR = "#00e5ff";
/** Total pulse duration; the node blinks on/off every 200ms within this window. */
const PULSE_MS = 1200;
/** Soft lavender for highlighted links. Readable against dark bg without being gaudy. */
const LINK_HIGHLIGHT = "#b892ff";
/** Non-highlighted edges during hover/selection — slightly darker than base so
 *  highlighted ones stand out, but still visible so the graph doesn't "collapse"
 *  visually the moment anything is selected. */
const LINK_DIM = "#2a2d36";
/** Default edge color when nothing is highlighted. A cool lavender-grey — forms
 *  a quiet network backdrop, like Supermemory's constellation web. */
const LINK_BASE = "#3a3d4a";

const graphEl = document.getElementById("graph");
const statusEl = document.getElementById("status");
const colorModeEl = document.getElementById("colorMode");
const hideOrphansEl = document.getElementById("hideOrphans");
const hideBrokenEl = document.getElementById("hideBroken");
const searchEl = document.getElementById("search");
const sideEl = document.getElementById("side");
const sidePathEl = document.getElementById("sidePath");
const sideMetaEl = document.getElementById("sideMeta");
const sideLinksEl = document.getElementById("sideLinks");
document.getElementById("closeSide").onclick = () => clearSelection();

/** @typedef {{id:string, path:string, title:string, type?:string, topic:string, primaryTag?:string, tags:string[], sources:string[], degree:number, inDegree:number, outDegree:number, orphan:boolean, broken:boolean}} Node */
/** @typedef {{source:string, target:string, type:string}} Edge */
/** @type {{nodes:Node[], edges:Edge[], builtAt:string, wikiDir:string}} */
let currentGraph = { nodes: [], edges: [], builtAt: "", wikiDir: "" };
let selectedId = null;
let highlightNodes = new Set();
let highlightLinks = new Set();

/** id → pulse start time (performance.now()). Nodes in this map flash while within PULSE_MS. */
const pulses = new Map();
/** Content signature per node; used to detect what changed between graph snapshots. */
const prevNodeHashes = new Map();
let hasInitialGraph = false;
let pulseRafId = null;

/** A page is an "index hub" if its slug is the literal root index or ends with
 *  /index — these aggregate a topic and should read as landmarks in the graph. */
function isIndex(n) {
  return n.id === "index" || n.id.endsWith("/index");
}

// Deterministic color hashing so topic/tag/type colors stay stable across reloads.
// Saturation/lightness tuned for a soft, pastel palette on dark bg — lower
// saturation than a typical hue wheel so nothing screams, high lightness so
// small nodes still read at a distance. `bright = true` lifts the shade for
// index hubs so they glow brighter than their topic's regular pages.
function colorFor(key, bright = false) {
  if (!key) return bright ? "#f0e6d6" : "#7f8696";
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return bright ? `hsl(${hue}, 60%, 82%)` : `hsl(${hue}, 45%, 72%)`;
}

function baseColor(n) {
  if (n.broken) return "#e88a8a";   // softened red — not alarming, still readable
  if (n.orphan) return "#545a66";   // muted grey for nodes with no incoming links
  const mode = colorModeEl.value;
  const key = mode === "topic" ? n.topic : mode === "tag" ? (n.primaryTag ?? "") : (n.type ?? "");
  return colorFor(key, isIndex(n));
}

function pulseVisible(id, now) {
  const start = pulses.get(id);
  if (start === undefined) return false;
  const age = now - start;
  if (age > PULSE_MS) {
    pulses.delete(id);
    return false;
  }
  // Blink every 200ms inside the window so it reads as an active pulse, not a static recolor.
  return Math.floor(age / 200) % 2 === 0;
}

function nodeColor(n) {
  if (pulses.size && pulseVisible(n.id, performance.now())) return PULSE_COLOR;
  if (n.id === selectedId) return SELECTED_COLOR;
  // Deliberately do NOT dim non-neighborhood nodes. Doing so recolors a huge
  // region of the canvas at once and reads as a jarring screen flash. Let the
  // selected node's yellow + highlighted edge colors carry the signal.
  return baseColor(n);
}

function nodeSize(n) {
  // Small by default, gentle growth with degree. Matches the "constellation of
  // tiny stars" feel — hubs read as slightly brighter points, not planets.
  const base = 1.2 + Math.sqrt(n.degree || 0) * 0.9;
  // Index hubs read as landmarks: ~2x the base size of a regular page. Combined
  // with the brighter color this gives them clear visual weight without needing
  // custom geometry.
  return isIndex(n) ? base * 2 : base;
}

function matchesFilter(n) {
  if (hideOrphansEl.checked && n.orphan && !n.broken) return false;
  if (hideBrokenEl.checked && n.broken) return false;
  const q = searchEl.value.trim().toLowerCase();
  if (!q) return true;
  return n.id.toLowerCase().includes(q) || (n.title ?? "").toLowerCase().includes(q);
}

const Graph = ForceGraph3D()(graphEl)
  // Warm blue-black — not pure black, gives the scene some depth.
  .backgroundColor("#0e1014")
  .nodeId("id")
  .nodeLabel((n) => `${n.title}${n.broken ? " (broken)" : ""}`)
  .nodeColor(nodeColor)
  .nodeVal(nodeSize)
  // Slightly translucent nodes: reads as luminescent dots rather than hard solids.
  .nodeOpacity(0.82)
  .linkColor((l) => {
    const k = linkKey(l);
    if (highlightLinks.has(k)) return LINK_HIGHLIGHT;
    if (highlightLinks.size) return LINK_DIM;
    return LINK_BASE;
  })
  // Keep width at 0 — that's the default GPU hairline (1px). Any value > 0
  // switches 3d-force-graph to a thick cylinder mesh, which looks heavy.
  // Emphasis is expressed through color contrast + opacity, not thickness.
  .linkWidth(0)
  .linkOpacity(0.4)
  .onNodeClick(onNodeClick)
  .onNodeHover(onNodeHover)
  .onBackgroundClick(clearSelection)
  .onNodeDragEnd((n) => {
    // Release the node so physics can continue to influence it. Remove if you
    // prefer Obsidian-style pinning after drag.
    n.fx = undefined;
    n.fy = undefined;
    n.fz = undefined;
  });

// Pull every node gently toward the origin so disconnected components (orphan
// pages, tiny sub-graphs) don't drift off into empty space. The force is weak
// enough that the main cluster's shape is preserved, but strong enough that
// islands stay reachable without scrolling the camera forever.
// Inline force avoids pulling in d3-force-3d as a runtime CDN dep.
Graph.d3Force("pull-to-origin", pullToOrigin(0.04));

function pullToOrigin(strength) {
  let nodes = [];
  // d3-force calls the force with the simulation's cooling alpha (1 → 0). We
  // must multiply by alpha so this force decays alongside repulsion; otherwise
  // it stays full-strength and eventually crushes every node to the origin.
  function force(alpha) {
    const k = strength * alpha;
    for (const n of nodes) {
      n.vx -= (n.x || 0) * k;
      n.vy -= (n.y || 0) * k;
      n.vz -= (n.z || 0) * k;
    }
  }
  force.initialize = (ns) => {
    nodes = ns;
  };
  return force;
}

function clearSelection() {
  selectedId = null;
  highlightNodes = new Set();
  highlightLinks = new Set();
  sideEl.classList.add("hidden");
  refreshColors();
}

function linkKey(l) {
  const s = typeof l.source === "object" ? l.source.id : l.source;
  const t = typeof l.target === "object" ? l.target.id : l.target;
  return `${s}→${t}`;
}

function refreshColors() {
  Graph.nodeColor(Graph.nodeColor()).linkColor(Graph.linkColor());
}

/** Compact signature of the fields we care about for "did this node change?" */
function nodeHash(n) {
  return `${n.title}${n.type ?? ""}${n.topic}${n.inDegree}${n.outDegree}${n.broken ? 1 : 0}`;
}

/** Diff the incoming graph against the last one; start a pulse on anything new or changed. */
function markPulses(newGraph) {
  const now = performance.now();
  const nextIds = new Set();
  for (const n of newGraph.nodes) {
    nextIds.add(n.id);
    const h = nodeHash(n);
    if (prevNodeHashes.get(n.id) !== h) pulses.set(n.id, now);
    prevNodeHashes.set(n.id, h);
  }
  for (const id of [...prevNodeHashes.keys()]) {
    if (!nextIds.has(id)) prevNodeHashes.delete(id);
  }
  if (pulses.size > 0) startPulseLoop();
}

function startPulseLoop() {
  if (pulseRafId !== null) return;
  const tick = () => {
    refreshColors();
    if (pulses.size === 0) {
      pulseRafId = null;
      return;
    }
    pulseRafId = requestAnimationFrame(tick);
  };
  pulseRafId = requestAnimationFrame(tick);
}

function applyGraph(g) {
  const isFirst = !hasInitialGraph;
  currentGraph = g;

  // Diff against the previous graph to trigger edit pulses — but on the very
  // first load we just seed the hash map, otherwise every node would flash.
  if (isFirst) {
    for (const n of g.nodes) prevNodeHashes.set(n.id, nodeHash(n));
    hasInitialGraph = true;
  } else {
    markPulses(g);
  }

  const visible = new Set(g.nodes.filter(matchesFilter).map((n) => n.id));

  // When hiding orphans, cascade: nodes whose only connections were to orphans
  // become visually isolated after orphan removal — hide them too.
  if (hideOrphansEl.checked) {
    let changed = true;
    while (changed) {
      changed = false;
      const connected = new Set();
      for (const e of g.edges) {
        if (visible.has(e.source) && visible.has(e.target)) {
          connected.add(e.source);
          connected.add(e.target);
        }
      }
      const toRemove = [];
      for (const id of visible) {
        if (!connected.has(id)) toRemove.push(id);
      }
      for (const id of toRemove) visible.delete(id);
      if (toRemove.length) changed = true;
    }
  }

  const nodes = g.nodes.filter((n) => visible.has(n.id));
  const links = g.edges
    .filter((e) => visible.has(e.source) && visible.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));
  Graph.graphData({ nodes, links });

  // If the selected node survived the update, refresh its highlight neighborhood
  // against the new edges. Otherwise drop the selection.
  if (selectedId) {
    const stillPresent = visible.has(selectedId);
    if (!stillPresent) {
      clearSelection();
    } else {
      const { nodes: nn, links: ll } = neighborhood(selectedId, 2);
      highlightNodes = nn;
      highlightLinks = ll;
      refreshColors();
    }
  }
}

function onNodeHover(n) {
  if (!n) {
    // If a node is selected, keep its neighborhood highlighted instead of
    // clearing — otherwise selection becomes invisible the moment the cursor
    // leaves the node.
    if (selectedId) {
      const { nodes, links } = neighborhood(selectedId, 2);
      highlightNodes = nodes;
      highlightLinks = links;
    } else {
      highlightNodes = new Set();
      highlightLinks = new Set();
    }
    refreshColors();
    return;
  }
  const { nodes, links } = neighborhood(n.id, 2);
  highlightNodes = nodes;
  highlightLinks = links;
  refreshColors();
}

/** Track consecutive clicks on the same node to detect double-click ourselves —
 *  3d-force-graph@1.73.4 doesn't expose onNodeDblClick. */
let lastClickNodeId = null;
let lastClickAt = 0;
const DBLCLICK_MS = 400;

function onNodeClick(n) {
  const now = performance.now();
  const isDouble = lastClickNodeId === n.id && now - lastClickAt < DBLCLICK_MS;
  lastClickNodeId = n.id;
  lastClickAt = now;

  selectedId = n.id;
  const { nodes, links } = neighborhood(n.id, 2);
  highlightNodes = nodes;
  highlightLinks = links;
  refreshColors();
  showSide(n);

  if (isDouble) {
    // Frame the 2-hop neighborhood so selected node + relations + edges are
    // all in view together (Obsidian-style "focus on this cluster").
    Graph.zoomToFit(700, 80, (node) => nodes.has(node.id));
  }
  // Single-click is intentionally non-disruptive: no camera motion.
}

function neighborhood(id, hops) {
  const nodes = new Set([id]);
  const links = new Set();
  let frontier = new Set([id]);
  for (let i = 0; i < hops; i++) {
    const next = new Set();
    for (const e of currentGraph.edges) {
      if (frontier.has(e.source) && !nodes.has(e.target)) {
        next.add(e.target);
        links.add(`${e.source}→${e.target}`);
      } else if (frontier.has(e.target) && !nodes.has(e.source)) {
        next.add(e.source);
        links.add(`${e.source}→${e.target}`);
      } else if (frontier.has(e.source) || frontier.has(e.target)) {
        links.add(`${e.source}→${e.target}`);
      }
    }
    for (const x of next) nodes.add(x);
    frontier = next;
  }
  return { nodes, links };
}

async function showSide(n) {
  sideEl.classList.remove("hidden");
  sidePathEl.textContent = n.broken ? `(broken) ${n.path}` : n.path;

  const meta = [];
  if (n.title) meta.push(["title", n.title]);
  if (n.type) meta.push(["type", n.type]);
  if (n.topic) meta.push(["topic", n.topic]);
  if (n.tags?.length) meta.push(["tags", n.tags.join(", ")]);
  if (n.sources?.length) meta.push(["sources", n.sources.join(", ")]);
  meta.push(["degree", `${n.degree} (in ${n.inDegree}, out ${n.outDegree})`]);
  if (n.orphan) meta.push(["status", "orphan"]);
  if (n.broken) meta.push(["status", "broken link target"]);
  sideMetaEl.innerHTML = meta.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join("");

  const outgoing = currentGraph.edges.filter((e) => e.source === n.id);
  const incoming = currentGraph.edges.filter((e) => e.target === n.id);
  const idToNode = new Map(currentGraph.nodes.map((x) => [x.id, x]));

  const renderList = (edges, which) =>
    edges
      .map((e) => {
        const other = which === "out" ? e.target : e.source;
        const node = idToNode.get(other);
        const cls = node?.broken ? "broken" : "";
        return `<li class="${cls}" data-id="${escapeAttr(other)}">${escapeHtml(node?.title ?? other)}</li>`;
      })
      .join("");

  sideLinksEl.innerHTML = `
    ${outgoing.length ? `<h3>outgoing (${outgoing.length})</h3><ul data-dir="out">${renderList(outgoing, "out")}</ul>` : ""}
    ${incoming.length ? `<h3>incoming (${incoming.length})</h3><ul data-dir="in">${renderList(incoming, "in")}</ul>` : ""}
    <h3>file</h3>
    <div id="fileInfo">checking…</div>
  `;

  sideLinksEl.querySelectorAll("li").forEach((li) => {
    li.onclick = () => {
      const id = li.getAttribute("data-id");
      const target = idToNode.get(id);
      if (target) onNodeClick(target);
    };
  });

  // Ask the server to resolve the absolute file path for copy/paste.
  if (!n.broken) {
    try {
      const r = await fetch("/api/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: n.path }),
      });
      const data = await r.json();
      const fileInfo = document.getElementById("fileInfo");
      if (fileInfo) fileInfo.innerHTML = data.exists ? `<code>${escapeHtml(data.path)}</code>` : `<em>missing: ${escapeHtml(data.path)}</em>`;
    } catch {
      /* non-fatal */
    }
  } else {
    const fileInfo = document.getElementById("fileInfo");
    if (fileInfo) fileInfo.innerHTML = `<em>no file — this is a broken link target</em>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// Wire filter controls
for (const el of [colorModeEl, hideOrphansEl, hideBrokenEl]) {
  el.addEventListener("change", () => applyGraph(currentGraph));
}
let searchTimer;
searchEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => applyGraph(currentGraph), 80);
});

// Realtime: SSE stream from /api/events
function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = `status ${cls ?? ""}`;
}

let statusRevertTimer = null;

function setLiveStatus(newGraph, before, isFirst) {
  const after = newGraph.nodes.length;
  const base = `live · ${after} nodes`;
  let msg = base;
  if (!isFirst) {
    const delta = after - before;
    if (delta !== 0) msg = `${base} (${delta > 0 ? "+" : ""}${delta})`;
    else if (pulses.size > 0) msg = `${base} · updated`;
  }
  setStatus(msg, "ok");
  // Transient annotations fade back to the plain count after ~2.5s.
  if (statusRevertTimer) clearTimeout(statusRevertTimer);
  if (msg !== base) statusRevertTimer = setTimeout(() => setStatus(base, "ok"), 2500);
}

function connect() {
  setStatus("connecting…");
  const es = new EventSource("/api/events");
  es.addEventListener("graph", (ev) => {
    const g = JSON.parse(ev.data);
    const before = currentGraph.nodes.length;
    const isFirst = !hasInitialGraph;
    applyGraph(g);
    setLiveStatus(g, before, isFirst);
  });
  es.addEventListener("error", () => {
    setStatus("disconnected — retrying", "err");
  });
  es.addEventListener("open", () => setStatus("live", "ok"));
}
connect();

/** Move the camera toward or away from its current look-at by a multiplicative
 *  factor. < 1 = zoom in, > 1 = zoom out. Works regardless of the camera's
 *  current angle because we scale its position vector along the same direction. */
function zoomByFactor(factor) {
  const cam = Graph.camera();
  const p = cam.position;
  Graph.cameraPosition({ x: p.x * factor, y: p.y * factor, z: p.z * factor }, undefined, 300);
}

function goHome() {
  if (selectedId) clearSelection();
  Graph.zoomToFit(600, 60);
}

document.getElementById("zoomOut").addEventListener("click", () => zoomByFactor(1.25));
document.getElementById("zoomIn").addEventListener("click", () => zoomByFactor(0.8));
document.getElementById("home").addEventListener("click", goHome);

document.addEventListener("keydown", (ev) => {
  if (isTypingInInput(ev.target)) return;
  if (ev.key === "Escape" && selectedId) clearSelection();
  else if (ev.key === "f" || ev.key === "h") goHome();
  else if (ev.key === "+" || ev.key === "=") zoomByFactor(0.8);
  else if (ev.key === "-" || ev.key === "_") zoomByFactor(1.25);
});

function isTypingInInput(el) {
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

// Also do an initial plain fetch in case SSE is blocked by an intermediary.
fetch("/api/graph")
  .then((r) => r.json())
  .then((g) => {
    if (!currentGraph.nodes.length) applyGraph(g);
  })
  .catch(() => {});
