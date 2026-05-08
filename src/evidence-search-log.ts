/**
 * Evidence-first search telemetry — one event per buildSearchEnvelope call.
 * Feeds the Search trust section of the evidence-report dashboard.
 *
 * Storage: append-only JSONL at `.agent-wiki/evidence-search-log.jsonl`.
 * Same 10MB / 30d rotation policy as evidence-write-log.
 */

import { join } from "node:path";
import {
  appendJsonlEvent,
  readJsonlInWindow,
  rotateJsonlFile,
} from "./jsonl-log.js";
import { evidenceDir } from "./evidence-write-log.js";

const SEARCH_LOG_FILE = "evidence-search-log.jsonl";

export interface SearchEvent {
  timestamp: string;
  abstainReason: "no-results" | "below-floor" | null;
  top1Score: number | null;
  top1Top2Ratio: number | null;
  confidence: "strong" | "weak" | "absent";
}

export function searchLogPath(workspace: string): string {
  return join(evidenceDir(workspace), SEARCH_LOG_FILE);
}

/**
 * Append a single search event. Best-effort — never throws.
 *
 * Note: synchronous append (see `appendJsonlEvent` in `jsonl-log.ts`) runs
 * on the search hot path. Acceptable at wiki-scale workloads (single-digit
 * searches per second); revisit with a buffered writer if telemetry ever
 * shows up in latency profiles.
 */
export function appendSearchEvent(workspace: string, event: SearchEvent): void {
  appendJsonlEvent(searchLogPath(workspace), event);
}

/** Read events within the rotation window. Malformed lines skipped. */
export function readSearchLog(
  workspace: string,
  now: Date = new Date(),
): SearchEvent[] {
  return readJsonlInWindow<SearchEvent>(searchLogPath(workspace), now);
}

/** Truncate the search log to rotation policy. Called from wiki_admin lint. */
export function rotateSearchLog(
  workspace: string,
  now: Date = new Date(),
): { entriesBefore: number; entriesAfter: number; bytesAfter: number } {
  return rotateJsonlFile(searchLogPath(workspace), now);
}
