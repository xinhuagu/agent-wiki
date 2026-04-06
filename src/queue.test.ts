import { describe, it, expect } from "vitest";
import { RequestQueue } from "./queue.js";

/** Helper: create a delayed function that records execution order */
function tracked(id: string, log: string[], delayMs = 10) {
  return async () => {
    log.push(`start:${id}`);
    await new Promise((r) => setTimeout(r, delayMs));
    log.push(`end:${id}`);
    return id;
  };
}

describe("RequestQueue", () => {
  it("serializes write operations", async () => {
    const q = new RequestQueue();
    const log: string[] = [];

    const [a, b, c] = await Promise.all([
      q.write(tracked("w1", log)),
      q.write(tracked("w2", log)),
      q.write(tracked("w3", log)),
    ]);

    expect(a).toBe("w1");
    expect(b).toBe("w2");
    expect(c).toBe("w3");

    // Writes must not overlap: each end before the next start
    expect(log).toEqual([
      "start:w1", "end:w1",
      "start:w2", "end:w2",
      "start:w3", "end:w3",
    ]);
  });

  it("allows concurrent reads", async () => {
    const q = new RequestQueue();
    const log: string[] = [];

    await Promise.all([
      q.read(tracked("r1", log, 20)),
      q.read(tracked("r2", log, 20)),
      q.read(tracked("r3", log, 20)),
    ]);

    // All reads should start before any ends (concurrent)
    const starts = log.filter((e) => e.startsWith("start:"));
    const firstEnd = log.findIndex((e) => e.startsWith("end:"));
    expect(starts.length).toBe(3);
    // All 3 starts should appear before the first end
    expect(firstEnd).toBeGreaterThanOrEqual(3);
  });

  it("writes wait for in-flight reads to drain", async () => {
    const q = new RequestQueue();
    const log: string[] = [];

    // Start a slow read, then queue a write
    const readPromise = q.read(tracked("r1", log, 30));
    // Give the read a moment to start
    await new Promise((r) => setTimeout(r, 5));

    const writePromise = q.write(tracked("w1", log));

    await Promise.all([readPromise, writePromise]);

    // Read must complete before write starts
    const readEnd = log.indexOf("end:r1");
    const writeStart = log.indexOf("start:w1");
    expect(readEnd).toBeLessThan(writeStart);
  });

  it("reads are not starved by queued writes", async () => {
    const q = new RequestQueue();
    const log: string[] = [];

    // Start a write, then queue a read while write is running
    const writePromise = q.write(tracked("w1", log, 30));
    // Give write time to start
    await new Promise((r) => setTimeout(r, 5));
    const readPromise = q.read(tracked("r1", log));

    await Promise.all([writePromise, readPromise]);

    // Read must wait for the running write, but not be blocked indefinitely
    const writeEnd = log.indexOf("end:w1");
    const readStart = log.indexOf("start:r1");
    expect(writeEnd).toBeLessThan(readStart);
  });

  it("propagates errors without blocking the queue", async () => {
    const q = new RequestQueue();

    const failingWrite = q.write(async () => {
      throw new Error("boom");
    });

    await expect(failingWrite).rejects.toThrow("boom");

    // Queue should still work after error
    const result = await q.write(async () => "ok");
    expect(result).toBe("ok");
  });

  it("respects maxReadConcurrency", async () => {
    const q = new RequestQueue(2); // only 2 concurrent reads
    let peak = 0;
    let active = 0;

    const trackConcurrency = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    };

    await Promise.all([
      q.read(trackConcurrency),
      q.read(trackConcurrency),
      q.read(trackConcurrency),
      q.read(trackConcurrency),
    ]);

    expect(peak).toBeLessThanOrEqual(2);
  });

  it("rejects operations that exceed timeout", async () => {
    const q = new RequestQueue(8, 50); // 50ms timeout

    // Block the queue with a slow write
    let resolveBlocker!: () => void;
    const blocker = q.write(() => new Promise<void>((r) => { resolveBlocker = r; }));
    await new Promise((r) => setTimeout(r, 5));

    // Queue another write that will timeout waiting
    const timedOut = q.write(async () => "should-not-run");

    await expect(timedOut).rejects.toThrow("timed out");

    // Unblock and verify queue still works
    resolveBlocker();
    await blocker;
    const result = await q.write(async () => "ok");
    expect(result).toBe("ok");
  });

  it("reports stats correctly", async () => {
    const q = new RequestQueue();

    expect(q.stats).toEqual({
      readActive: 0,
      readQueued: 0,
      writeRunning: false,
      writeQueued: 0,
    });

    // Queue a slow write to observe stats
    let resolve!: () => void;
    const writePromise = q.write(
      () => new Promise<void>((r) => { resolve = r; })
    );
    // Let the write start
    await new Promise((r) => setTimeout(r, 5));

    expect(q.stats.writeRunning).toBe(true);

    resolve();
    await writePromise;

    expect(q.stats.writeRunning).toBe(false);
  });
});
