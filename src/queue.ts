/**
 * Async read-write request queue for MCP concurrency control.
 *
 * Problem: MCP SDK dispatches multiple tool calls in parallel.
 * Our file I/O is synchronous and has no locking, so concurrent
 * writes cause TOCTOU races (e.g. log.md corruption, raw immutability
 * violations, lost timestamps).
 *
 * Solution: serialize all mutating (write) operations while allowing
 * bounded concurrent reads. Writes wait for in-flight reads to drain
 * before executing, preventing dirty reads.
 *
 * Timeout: operations that exceed the configured timeout are rejected
 * to prevent queue starvation (e.g. a slow raw_fetch blocking all reads).
 *
 * This is intentionally simple — no file-level locking, no external
 * dependencies. A single-process MCP server over stdio doesn't need
 * distributed locks.
 */

type Deferred<T = unknown> = {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export class RequestQueue {
  private readonly maxReadConcurrency: number;
  private readonly timeoutMs: number;

  // Write state
  private writeQueue: Deferred[] = [];
  private writeRunning = false;

  // Read state
  private readQueue: Deferred[] = [];
  private readActive = 0;

  constructor(maxReadConcurrency = 8, timeoutMs = 120_000) {
    this.maxReadConcurrency = maxReadConcurrency;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Enqueue a read (non-mutating) operation.
   * Runs concurrently with other reads, up to maxReadConcurrency.
   * Waits if a write is currently running (but NOT if writes are merely queued —
   * this prevents queued writes from starving reads indefinitely).
   */
  read<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: Deferred = {
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      };
      entry.timer = setTimeout(() => {
        const idx = this.readQueue.indexOf(entry);
        if (idx !== -1) {
          this.readQueue.splice(idx, 1);
          reject(new Error("Read operation timed out waiting in queue"));
        }
      }, this.timeoutMs);
      this.readQueue.push(entry);
      this.drain();
    });
  }

  /**
   * Enqueue a write (mutating) operation.
   * Serialized: only one write runs at a time.
   * Waits for all in-flight reads to complete first.
   */
  write<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: Deferred = {
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      };
      entry.timer = setTimeout(() => {
        const idx = this.writeQueue.indexOf(entry);
        if (idx !== -1) {
          this.writeQueue.splice(idx, 1);
          reject(new Error("Write operation timed out waiting in queue"));
        }
      }, this.timeoutMs);
      this.writeQueue.push(entry);
      this.drain();
    });
  }

  /** Current queue statistics (useful for diagnostics). */
  get stats() {
    return {
      readActive: this.readActive,
      readQueued: this.readQueue.length,
      writeRunning: this.writeRunning,
      writeQueued: this.writeQueue.length,
    };
  }

  // ── Internal scheduling ──────────────────────────────────────

  private drain(): void {
    this.drainWrite();
    this.drainReads();
  }

  private drainWrite(): void {
    if (this.writeRunning) return;
    if (this.writeQueue.length === 0) return;
    // Wait for all in-flight reads to complete before starting a write
    if (this.readActive > 0) return;

    this.writeRunning = true;
    const entry = this.writeQueue.shift()!;
    if (entry.timer) clearTimeout(entry.timer);

    entry.fn().then(
      (result) => {
        this.writeRunning = false;
        entry.resolve(result);
        this.drain();
      },
      (err) => {
        this.writeRunning = false;
        entry.reject(err);
        this.drain();
      },
    );
  }

  private drainReads(): void {
    // Don't start reads while a write is actively running
    // (but queued writes don't block reads — prevents starvation)
    if (this.writeRunning) return;

    while (
      this.readQueue.length > 0 &&
      this.readActive < this.maxReadConcurrency
    ) {
      const entry = this.readQueue.shift()!;
      if (entry.timer) clearTimeout(entry.timer);
      this.readActive++;

      entry.fn().then(
        (result) => {
          this.readActive--;
          entry.resolve(result);
          this.drain();
        },
        (err) => {
          this.readActive--;
          entry.reject(err);
          this.drain();
        },
      );
    }
  }
}
