/**
 * Generic JSONL-with-rotation helper. Backs the evidence-first telemetry
 * sinks (write log, write counter, search log) with a single implementation
 * of the append / read-in-window / rotate-by-time-and-size triplet.
 *
 * Storage shape: one JSON object per line, every entry carries a string
 * `timestamp`. Anything else is opaque — callers parameterize on `T`.
 *
 * Rotation policy is fixed at 10 MB / 30 days for every caller. Make it
 * configurable only when a real second policy shows up.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const ROTATION_MAX_BYTES = 10 * 1024 * 1024;
const ROTATION_MAX_AGE_DAYS = 30;
const ROTATION_MAX_AGE_MS = ROTATION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/** Append a single event as one JSONL line. Best-effort — never throws. */
export function appendJsonlEvent<T>(path: string, event: T): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(event) + "\n");
  } catch {
    // Telemetry must never break the calling path.
  }
}

/**
 * Read events whose `timestamp` falls within the rotation window. Malformed
 * lines and entries missing a parseable timestamp are silently dropped.
 */
export function readJsonlInWindow<T extends { timestamp?: string }>(
  path: string,
  now: Date = new Date(),
): T[] {
  if (!existsSync(path)) return [];
  try {
    const cutoffMs = now.getTime() - ROTATION_MAX_AGE_MS;
    const lines = readFileSync(path, "utf-8").split("\n");
    const events: T[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as T;
        if (!entry.timestamp) continue;
        const t = new Date(entry.timestamp).getTime();
        if (Number.isFinite(t) && t >= cutoffMs) events.push(entry);
      } catch {
        // skip malformed line
      }
    }
    return events;
  } catch {
    return [];
  }
}

/**
 * Truncate the file to the rotation policy: drop entries older than 30
 * days, then if still over 10 MB drop oldest entries until it fits.
 */
export function rotateJsonlFile(
  path: string,
  now: Date = new Date(),
): { entriesBefore: number; entriesAfter: number; bytesAfter: number } {
  if (!existsSync(path)) {
    return { entriesBefore: 0, entriesAfter: 0, bytesAfter: 0 };
  }

  const cutoffMs = now.getTime() - ROTATION_MAX_AGE_MS;
  const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
  const entriesBefore = lines.length;

  const kept: { line: string; ts: number }[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { timestamp?: string };
      const t = entry.timestamp ? new Date(entry.timestamp).getTime() : NaN;
      if (Number.isFinite(t) && t >= cutoffMs) kept.push({ line, ts: t });
    } catch {
      // malformed — drop
    }
  }

  kept.sort((a, b) => a.ts - b.ts);
  let totalBytes = kept.reduce(
    (acc, { line }) => acc + Buffer.byteLength(line) + 1,
    0,
  );
  while (totalBytes > ROTATION_MAX_BYTES && kept.length > 0) {
    const dropped = kept.shift()!;
    totalBytes -= Buffer.byteLength(dropped.line) + 1;
  }

  const newContent =
    kept.length === 0 ? "" : kept.map((k) => k.line).join("\n") + "\n";
  writeFileSync(path, newContent);
  return {
    entriesBefore,
    entriesAfter: kept.length,
    bytesAfter: Buffer.byteLength(newContent),
  };
}
