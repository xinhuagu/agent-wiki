/**
 * Evidence-first phase 2a — telemetry log for `wiki_write` calls that
 * produce "unsupported" pages (no `sources: [...]`, no `synthesis: true`).
 *
 * The log seeds Phase 2b: until we know how often unsupported writes
 * happen and whether they are legitimate, hard rejection is guesswork.
 *
 * Design:
 *   - Append-only JSONL at <workspace>/.agent-wiki/evidence-write-log.jsonl
 *   - One UnsupportedWriteEvent per stamped write
 *   - Rotation cap: 10 MB or 30 days, whichever first
 *   - Rotation runs from `wiki_admin lint`; new entries that overflow the
 *     time window are quietly dropped on read so the file can grow up to
 *     its size cap before being touched
 *
 * See docs/evidence-envelope.md ("Unsupported-write telemetry").
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface UnsupportedWriteEvent {
  /** Wiki-relative path of the page that was just stamped unsupported. */
  page: string;
  /** ISO 8601 timestamp at write time. */
  timestamp: string;
  /** Optional caller hint passed through `wiki.write(path, content, source)`. */
  agentHint?: string;
  /**
   * Whether the writer set `synthesis: true` on the page. Always false for
   * an unsupported event by definition (synthesis pages aren't unsupported);
   * carried for forward compatibility if the log shape ever broadens.
   */
  hadSynthesisFlag: boolean;
  /** Length of `sources: [...]` at write time. Always 0 for unsupported. */
  rawSourcesCount: number;
}

const ROTATION_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ROTATION_MAX_AGE_DAYS = 30;

/** Path conventions, relative to a workspace root. */
const EVIDENCE_DIR = ".agent-wiki";
const WRITE_LOG_FILE = "evidence-write-log.jsonl";
const MIGRATION_MARKER_FILE = "evidence-migrated";

export function evidenceDir(workspace: string): string {
  return join(workspace, EVIDENCE_DIR);
}
export function writeLogPath(workspace: string): string {
  return join(workspace, EVIDENCE_DIR, WRITE_LOG_FILE);
}
export function migrationMarkerPath(workspace: string): string {
  return join(workspace, EVIDENCE_DIR, MIGRATION_MARKER_FILE);
}

/** Append a single unsupported-write event. Best-effort — never throws. */
export function appendUnsupportedWriteEvent(
  workspace: string,
  event: UnsupportedWriteEvent,
): void {
  try {
    const path = writeLogPath(workspace);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(event) + "\n");
  } catch {
    // Telemetry must never break the write itself.
  }
}

/**
 * Read the log and return entries within the rotation window. Entries
 * outside the time window are silently dropped from the returned list
 * (they're cleaned out of the file by `rotateEventLog`). Best-effort —
 * malformed lines are skipped.
 */
export function readWriteLog(
  workspace: string,
  now: Date = new Date(),
): UnsupportedWriteEvent[] {
  const path = writeLogPath(workspace);
  if (!existsSync(path)) return [];
  try {
    const cutoffMs = now.getTime() - ROTATION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const lines = readFileSync(path, "utf-8").split("\n");
    const events: UnsupportedWriteEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as UnsupportedWriteEvent;
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
 * Truncate the log file in-place to rotation policy: drop entries older
 * than 30 days, then if the result still exceeds 10 MB drop oldest
 * entries until it fits. Called from `wiki_admin lint`.
 */
export function rotateEventLog(
  workspace: string,
  now: Date = new Date(),
): { entriesBefore: number; entriesAfter: number; bytesAfter: number } {
  const path = writeLogPath(workspace);
  if (!existsSync(path)) {
    return { entriesBefore: 0, entriesAfter: 0, bytesAfter: 0 };
  }

  const cutoffMs = now.getTime() - ROTATION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
  const entriesBefore = lines.length;

  // First pass: drop entries older than the time window.
  const kept: { line: string; ts: number }[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as UnsupportedWriteEvent;
      const t = entry.timestamp ? new Date(entry.timestamp).getTime() : NaN;
      if (Number.isFinite(t) && t >= cutoffMs) {
        kept.push({ line, ts: t });
      }
    } catch {
      // malformed — drop
    }
  }

  // Second pass: if still over size cap, drop oldest entries.
  kept.sort((a, b) => a.ts - b.ts);
  let totalBytes = kept.reduce((acc, { line }) => acc + Buffer.byteLength(line) + 1, 0);
  while (totalBytes > ROTATION_MAX_BYTES && kept.length > 0) {
    const dropped = kept.shift()!;
    totalBytes -= Buffer.byteLength(dropped.line) + 1;
  }

  const newContent = kept.length === 0 ? "" : kept.map((k) => k.line).join("\n") + "\n";
  writeFileSync(path, newContent);
  return {
    entriesBefore,
    entriesAfter: kept.length,
    bytesAfter: Buffer.byteLength(newContent),
  };
}

/**
 * Count writes in the last 7 days, broken down for a one-line summary
 * the rebuild step appends to wiki/log.md. Phase 4 will replace this
 * with a richer dashboard.
 */
export function summarizeLastWeek(
  workspace: string,
  now: Date = new Date(),
): { unsupportedCount: number } {
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const cutoff = now.getTime() - sevenDaysMs;
  const events = readWriteLog(workspace, now);
  const recent = events.filter((e) => {
    const t = new Date(e.timestamp).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  return { unsupportedCount: recent.length };
}
