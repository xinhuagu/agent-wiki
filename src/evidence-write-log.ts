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

import { join } from "node:path";
import {
  appendJsonlEvent,
  readJsonlInWindow,
  rotateJsonlFile,
} from "./jsonl-log.js";

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
  /**
   * Phase 2b: `true` when the write was blocked by hard-reject mode.
   * Absent on Phase 2a soft-warn writes. Lets the dashboard distinguish
   * "stamped" from "blocked" and shows how often agents hit the rail.
   *
   * Note: unlike Phase 2a stamped events (which dedupe via the on-disk
   * `unsupported: true` flag — the page transitions in once and stays),
   * reject events fire on EVERY blocked attempt. A retry loop will
   * generate one event per attempt. Dashboards should count distinct
   * (page, day) pairs rather than raw event counts when comparing
   * blocked-rate against stamped-rate.
   */
  rejected?: boolean;
  /**
   * Phase 2b: classifies why the reject path fired. `"fresh"` = page had
   * neither sources nor synthesis on a first-time submission; `"legacy"`
   * = page was already tagged `legacyUnsupported` and the new write
   * didn't transition into grounded or synthesis. Absent on non-rejected
   * (Phase 2a stamped) events.
   */
  rejectReason?: "fresh" | "legacy";
}

/** Path conventions, relative to a workspace root. */
const EVIDENCE_DIR = ".agent-wiki";
const WRITE_LOG_FILE = "evidence-write-log.jsonl";
const COUNTER_LOG_FILE = "evidence-write-counter.jsonl";
const MIGRATION_MARKER_FILE = "evidence-migrated";

export function evidenceDir(workspace: string): string {
  return join(workspace, EVIDENCE_DIR);
}
export function writeLogPath(workspace: string): string {
  return join(workspace, EVIDENCE_DIR, WRITE_LOG_FILE);
}
export function counterLogPath(workspace: string): string {
  return join(workspace, EVIDENCE_DIR, COUNTER_LOG_FILE);
}
export function migrationMarkerPath(workspace: string): string {
  return join(workspace, EVIDENCE_DIR, MIGRATION_MARKER_FILE);
}

/**
 * Classification kinds for the per-write counter. Mirrors the branches in
 * `wiki.ts` evidence classification — every classified write emits exactly
 * one event, regardless of whether it transitions in/out of unsupported.
 *
 * - `grounded`   — page has non-empty `sources: [...]`
 * - `synthesis`  — page has `synthesis: true` or `type: synthesis`
 * - `unsupported`— page has neither, soft-warn mode (Phase 2a)
 * - `rejected`   — page has neither, hard-reject mode (Phase 2b)
 * - `legacy`     — page is tagged `legacyUnsupported`, soft-warn (skipped in unsupported log)
 */
export type WriteEventKind =
  | "grounded"
  | "synthesis"
  | "unsupported"
  | "rejected"
  | "legacy";

export interface WriteEvent {
  timestamp: string;
  kind: WriteEventKind;
}

/** Append a single unsupported-write event. Best-effort — never throws. */
export function appendUnsupportedWriteEvent(
  workspace: string,
  event: UnsupportedWriteEvent,
): void {
  appendJsonlEvent(writeLogPath(workspace), event);
}

/**
 * Append a per-write counter event — fired on every evidence-classified
 * write so the dashboard can compute (unsupported / total) ratios. Unlike
 * `appendUnsupportedWriteEvent` (which dedupes on the unsupported transition),
 * this fires on every classified write attempt. Best-effort — never throws.
 */
export function appendWriteEvent(
  workspace: string,
  kind: WriteEventKind,
  timestamp: string,
): void {
  appendJsonlEvent(counterLogPath(workspace), { timestamp, kind });
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
  return readJsonlInWindow<UnsupportedWriteEvent>(writeLogPath(workspace), now);
}

/**
 * Read the per-write counter log within the 30-day rotation window. Same
 * filtering rules as `readWriteLog`.
 */
export function readWriteCounter(
  workspace: string,
  now: Date = new Date(),
): WriteEvent[] {
  return readJsonlInWindow<WriteEvent>(counterLogPath(workspace), now);
}

/**
 * Truncate both evidence log files (the unsupported-only log and the
 * per-write counter) to rotation policy: drop entries older than 30 days,
 * then if the result still exceeds 10 MB drop oldest entries until it
 * fits. Called from `wiki_admin lint`.
 *
 * Returns combined counts across both files for the legacy single-file
 * shape; per-file detail is available via `counter` / `unsupported`.
 */
export function rotateEventLog(
  workspace: string,
  now: Date = new Date(),
): {
  entriesBefore: number;
  entriesAfter: number;
  bytesAfter: number;
  unsupported: { entriesBefore: number; entriesAfter: number; bytesAfter: number };
  counter: { entriesBefore: number; entriesAfter: number; bytesAfter: number };
} {
  const unsupported = rotateJsonlFile(writeLogPath(workspace), now);
  const counter = rotateJsonlFile(counterLogPath(workspace), now);
  return {
    entriesBefore: unsupported.entriesBefore + counter.entriesBefore,
    entriesAfter: unsupported.entriesAfter + counter.entriesAfter,
    bytesAfter: unsupported.bytesAfter + counter.bytesAfter,
    unsupported,
    counter,
  };
}

/**
 * Count writes in the last 7 days, broken down for a one-line summary
 * the rebuild step appends to wiki/log.md. Coexists with the Phase 4
 * `wiki_admin --action evidence-report` dashboard: this stays as the
 * cheap inline glance during rebuild; the dashboard is the full report
 * when the operator asks for one.
 *
 * Returned numerators answer different questions:
 *
 * - `unsupportedTransitions` — distinct pages that *became* unsupported
 *   (from `evidence-write-log.jsonl`, deduped on transition). Answers:
 *   "how many new unsupported pages did agents introduce?"
 *
 * - `unsupportedWrites` — every write that ended up unsupported in
 *   warn mode, including re-edits (counter `kind: "unsupported"`).
 *
 * - `rejectedWrites` — every write blocked under Phase 2b reject mode
 *   (counter `kind: "rejected"`).
 *
 * `wouldRejectRatio` = `(unsupportedWrites + rejectedWrites) / totalWrites`.
 * Mode-invariant: in warn mode, `rejectedWrites = 0` and the ratio
 * reflects what 2b would block; in reject mode, `unsupportedWrites = 0`
 * and the ratio reflects what 2b is currently blocking. `null` when
 * `totalWrites === 0` to avoid a misleading 0% on early deployments.
 */
export function summarizeLastWeek(
  workspace: string,
  now: Date = new Date(),
): {
  unsupportedTransitions: number;
  unsupportedWrites: number;
  rejectedWrites: number;
  totalWrites: number;
  wouldRejectRatio: number | null;
} {
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const cutoff = now.getTime() - sevenDaysMs;
  const within = (ts: string) => {
    const t = new Date(ts).getTime();
    return Number.isFinite(t) && t >= cutoff;
  };
  // Exclude `rejected: true` entries: the unsupported log carries BOTH
  // warn-mode transitions (deduped) AND reject-mode attempts (one per
  // blocked retry). Only the former are real "new unsupported pages".
  const unsupportedTransitions = readWriteLog(workspace, now)
    .filter((e) => within(e.timestamp) && !e.rejected)
    .length;
  const recentCounter = readWriteCounter(workspace, now)
    .filter((e) => within(e.timestamp));
  const totalWrites = recentCounter.length;
  const unsupportedWrites = recentCounter.filter(
    (e) => e.kind === "unsupported",
  ).length;
  const rejectedWrites = recentCounter.filter(
    (e) => e.kind === "rejected",
  ).length;
  const wouldRejectRatio =
    totalWrites === 0
      ? null
      : (unsupportedWrites + rejectedWrites) / totalWrites;
  return {
    unsupportedTransitions,
    unsupportedWrites,
    rejectedWrites,
    totalWrites,
    wouldRejectRatio,
  };
}
