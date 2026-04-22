import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { startServer } from "../src/server.js";

describe("startServer", () => {
  it("serves built graph over /api/graph and streams updates via /api/events", async () => {
    const wikiDir = mkdtempSync(join(tmpdir(), "aw-graph-server-"));
    writeFileSync(join(wikiDir, "a.md"), "# A\n\nsee [[b]]");
    writeFileSync(join(wikiDir, "b.md"), "# B\n");

    // Port 0 = OS-assigned. We parse the URL to learn the actual port.
    const server = await startServer({ wikiDir, port: 0, debounceMs: 25 });
    try {
      const port = new URL(server.url).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/graph`);
      expect(res.status).toBe(200);
      const g = (await res.json()) as { nodes: Array<{ id: string }>; edges: unknown[] };
      expect(g.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
      expect(g.edges).toHaveLength(1);

      // File-change watcher: rewrite a.md to add a broken link and wait for SSE push.
      const es = new EventSourceLite(`http://127.0.0.1:${port}/api/events`);
      await es.ready;
      const nextEvent = es.nextGraph();
      writeFileSync(join(wikiDir, "a.md"), "# A\n\n[[b]] and [[nope]]");
      const updated = (await nextEvent) as { nodes: Array<{ id: string; broken: boolean }> };
      const broken = updated.nodes.find((n) => n.broken);
      expect(broken?.id).toBe("__broken__:nope");
      es.close();
    } finally {
      await server.close();
      rmSync(wikiDir, { recursive: true, force: true });
    }
  }, 10_000);
});

/**
 * Minimal SSE reader for tests — EventSource isn't available in Node by default,
 * and pulling in a dep just for one test isn't worth it.
 */
class EventSourceLite {
  ready: Promise<void>;
  private controller = new AbortController();
  private buffer = "";
  private waiters: Array<(data: unknown) => void> = [];
  private first = true;
  private resolveReady!: () => void;

  constructor(url: string) {
    this.ready = new Promise((r) => (this.resolveReady = r));
    this.run(url).catch(() => {});
  }

  private async run(url: string): Promise<void> {
    const res = await fetch(url, { signal: this.controller.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      this.buffer += dec.decode(value, { stream: true });
      let idx;
      while ((idx = this.buffer.indexOf("\n\n")) >= 0) {
        const chunk = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const data = JSON.parse(line.slice(5).trim());
        if (this.first) {
          this.first = false;
          this.resolveReady();
          continue;
        }
        const next = this.waiters.shift();
        if (next) next(data);
      }
    }
  }

  nextGraph(): Promise<unknown> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.controller.abort();
  }
}
