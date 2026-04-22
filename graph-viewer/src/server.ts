import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph } from "./graph.js";
import { readWikiPages } from "./parse.js";
import type { Graph } from "./types.js";

export interface ServeOptions {
  wikiDir: string;
  port?: number;
  host?: string;
  /** Directory with static frontend assets. Defaults to ../public next to dist/. */
  publicDir?: string;
  /** Debounce window for file-change → rebuild in ms. */
  debounceMs?: number;
}

export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function defaultPublicDir(): string {
  // dist/server.js lives next to dist/, public/ is sibling of dist/
  const here = fileURLToPath(new URL(".", import.meta.url));
  return resolve(here, "..", "public");
}

export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  const wikiDir = resolve(opts.wikiDir);
  const port = opts.port ?? 4711;
  const host = opts.host ?? "127.0.0.1";
  const publicDir = resolve(opts.publicDir ?? defaultPublicDir());
  const debounceMs = opts.debounceMs ?? 150;

  let current: Graph = buildGraph(readWikiPages(wikiDir), wikiDir);
  const sseClients = new Set<ServerResponse>();

  const rebuild = () => {
    try {
      current = buildGraph(readWikiPages(wikiDir), wikiDir);
      broadcast("graph", current);
    } catch (err) {
      broadcast("error", { message: (err as Error).message });
    }
  };

  const broadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        // client may have disconnected mid-write; cleanup happens on 'close'
      }
    }
  };

  // File watcher: fs.watch with { recursive: true } is supported on macOS/Windows.
  // On Linux it also works for most cases; if not, user can still manually refresh.
  let debounceTimer: NodeJS.Timeout | null = null;
  const watcher = watch(wikiDir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const name = String(filename);
    if (!name.endsWith(".md")) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(rebuild, debounceMs);
  });

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain; charset=utf-8");
      }
      res.end(`Internal error: ${(err as Error).message}`);
    }
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);

    if (url.pathname === "/api/graph") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify(current));
      return;
    }

    if (url.pathname === "/api/events") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-store");
      res.setHeader("connection", "keep-alive");
      res.setHeader("x-accel-buffering", "no");
      res.write(`retry: 2000\n\n`);
      res.write(`event: graph\ndata: ${JSON.stringify(current)}\n\n`);
      sseClients.add(res);
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    if (url.pathname === "/api/open" && req.method === "POST") {
      // Thin handoff: echo the resolved absolute path. Editor integration is
      // intentionally out of scope; the UI uses this to display a copyable path.
      let body = "";
      req.on("data", (c) => (body += c));
      await new Promise<void>((r) => req.on("end", () => r()));
      const parsed = JSON.parse(body || "{}") as { path?: string };
      const rel = parsed.path ?? "";
      const abs = join(wikiDir, rel);
      // guard against path escape
      if (!abs.startsWith(wikiDir + sep) && abs !== wikiDir) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "path escapes wiki root" }));
        return;
      }
      try {
        await stat(abs);
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ path: abs, exists: true }));
      } catch {
        res.statusCode = 404;
        res.end(JSON.stringify({ path: abs, exists: false }));
      }
      return;
    }

    // Static files from publicDir
    const relUrl = url.pathname === "/" ? "/index.html" : url.pathname;
    const safe = relUrl.replace(/\.\./g, "").replace(/^\/+/, "");
    const filePath = join(publicDir, safe);
    if (!filePath.startsWith(publicDir)) {
      res.statusCode = 400;
      res.end("bad path");
      return;
    }
    try {
      const buf = await readFile(filePath);
      const ct = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
      res.statusCode = 200;
      res.setHeader("content-type", ct);
      // Dev-oriented server: never let the browser cache assets, otherwise a
      // broken version can stick around across edits and make debugging awful.
      res.setHeader("cache-control", "no-store");
      res.end(buf);
    } catch {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("not found");
    }
  }

  await new Promise<void>((resolve2) => server.listen(port, host, resolve2));
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://${host}:${boundPort}`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve2, reject) => {
        watcher.close();
        for (const res of sseClients) res.end();
        sseClients.clear();
        if (debounceTimer) clearTimeout(debounceTimer);
        server.close((err) => (err ? reject(err) : resolve2()));
      }),
  };
}
