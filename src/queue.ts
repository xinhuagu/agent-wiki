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
 * This is intentionally simple — no file-level locking, no external
 * dependencies. A single-process MCP server over stdio doesn't need
 * distributed locks.
 */

type Deferred<T = unknown> = {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export class RequestQueue {
  private readonly maxReadConcurrency: number;

  // Write state
  private writeQueue: Deferred[] = [];
  private writeRunning = false;

  // Read state
  private readQueue: Deferred[] = [];
  private readActive = 0;

  constructor(maxReadConcurrency = 8) {
    this.maxReadConcurrency = maxReadConcurrency;
  }

  /**
   * Enqueue a read (non-mutating) operation.
   * Runs concurrently with other reads, up to maxReadConcurrency.
   * Waits if a write is running or queued (write priority).
   */
  read<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.readQueue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
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
      this.writeQueue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
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

    // Update state BEFORE resolving/rejecting so callers see clean state
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
    // Don't start reads while a write is running or queued (write priority)
    if (this.writeRunning || this.writeQueue.length > 0) return;

    while (
      this.readQueue.length > 0 &&
      this.readActive < this.maxReadConcurrency
    ) {
      const entry = this.readQueue.shift()!;
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
