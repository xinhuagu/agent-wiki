import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSearchEvent,
  readSearchLog,
  rotateSearchLog,
  searchLogPath,
  type SearchEvent,
} from "./evidence-search-log.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "evidence-search-log-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const event = (overrides: Partial<SearchEvent> = {}): SearchEvent => ({
  timestamp: "2026-05-06T10:00:00.000Z",
  abstainReason: null,
  top1Score: 5.0,
  top1Top2Ratio: 2.5,
  confidence: "strong",
  ...overrides,
});

describe("appendSearchEvent", () => {
  it("creates the .agent-wiki dir and writes a JSONL line", () => {
    appendSearchEvent(workspace, event());
    const path = searchLogPath(workspace);
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8").trim());
    expect(parsed.confidence).toBe("strong");
    expect(parsed.top1Top2Ratio).toBe(2.5);
  });

  it("appends multiple events as separate lines", () => {
    appendSearchEvent(workspace, event({ timestamp: "2026-05-06T10:00:00.000Z" }));
    appendSearchEvent(workspace, event({ timestamp: "2026-05-06T10:01:00.000Z" }));
    const lines = readFileSync(searchLogPath(workspace), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("does not throw when the workspace dir cannot be created", () => {
    // Point at a path nested under a regular file — mkdir will fail.
    writeFileSync(join(workspace, "not"), "this is a file, not a dir");
    const blocked = join(workspace, "not", "a", "real", "path");
    expect(() => appendSearchEvent(blocked, event())).not.toThrow();
  });

  it("preserves abstain shapes (null top1Top2Ratio for single-result match)", () => {
    appendSearchEvent(workspace, event({
      abstainReason: "no-results",
      top1Score: null,
      top1Top2Ratio: null,
      confidence: "absent",
    }));
    const events = readSearchLog(workspace, new Date("2026-05-07T00:00:00.000Z"));
    expect(events).toEqual([
      {
        timestamp: "2026-05-06T10:00:00.000Z",
        abstainReason: "no-results",
        top1Score: null,
        top1Top2Ratio: null,
        confidence: "absent",
      },
    ]);
  });
});

describe("readSearchLog", () => {
  it("returns events newer than the 30-day window", () => {
    appendSearchEvent(workspace, event({ timestamp: "2026-05-06T10:00:00.000Z" }));
    const events = readSearchLog(workspace, new Date("2026-05-07T00:00:00.000Z"));
    expect(events).toHaveLength(1);
  });

  it("filters out entries older than 30 days", () => {
    appendSearchEvent(workspace, event({ timestamp: "2026-01-01T00:00:00.000Z" }));
    appendSearchEvent(workspace, event({ timestamp: "2026-05-05T00:00:00.000Z" }));
    const events = readSearchLog(workspace, new Date("2026-05-06T00:00:00.000Z"));
    expect(events.map((e) => e.timestamp)).toEqual(["2026-05-05T00:00:00.000Z"]);
  });

  it("returns [] when the log file does not exist", () => {
    expect(readSearchLog(workspace)).toEqual([]);
  });

  it("skips malformed JSON lines without throwing", () => {
    mkdirSync(join(workspace, ".agent-wiki"), { recursive: true });
    writeFileSync(
      searchLogPath(workspace),
      `{"timestamp":"2026-05-06T10:00:00.000Z","abstainReason":null,"top1Score":3,"top1Top2Ratio":1.2,"confidence":"weak"}\n`
        + `not-json-at-all\n`
        + `{"timestamp":"2026-05-06T11:00:00.000Z","abstainReason":null,"top1Score":4,"top1Top2Ratio":2.5,"confidence":"strong"}\n`,
    );
    const events = readSearchLog(workspace, new Date("2026-05-07T00:00:00.000Z"));
    expect(events.map((e) => e.confidence)).toEqual(["weak", "strong"]);
  });

  it("skips entries missing a timestamp", () => {
    mkdirSync(join(workspace, ".agent-wiki"), { recursive: true });
    writeFileSync(
      searchLogPath(workspace),
      `{"abstainReason":null,"top1Score":1,"top1Top2Ratio":null,"confidence":"weak"}\n`
        + `{"timestamp":"2026-05-06T10:00:00.000Z","abstainReason":null,"top1Score":1,"top1Top2Ratio":null,"confidence":"weak"}\n`,
    );
    const events = readSearchLog(workspace, new Date("2026-05-07T00:00:00.000Z"));
    expect(events).toHaveLength(1);
  });
});

describe("rotateSearchLog", () => {
  it("returns zero counts when the log does not exist", () => {
    expect(rotateSearchLog(workspace)).toEqual({
      entriesBefore: 0,
      entriesAfter: 0,
      bytesAfter: 0,
    });
  });

  it("drops entries older than 30 days", () => {
    appendSearchEvent(workspace, event({ timestamp: "2025-01-01T00:00:00.000Z" }));
    appendSearchEvent(workspace, event({ timestamp: "2026-05-05T00:00:00.000Z" }));
    const result = rotateSearchLog(workspace, new Date("2026-05-06T00:00:00.000Z"));
    expect(result.entriesBefore).toBe(2);
    expect(result.entriesAfter).toBe(1);
    const remaining = readFileSync(searchLogPath(workspace), "utf-8");
    expect(remaining).toContain("2026-05-05");
    expect(remaining).not.toContain("2025-01-01");
  });

  it("drops oldest entries when total exceeds size cap", () => {
    mkdirSync(join(workspace, ".agent-wiki"), { recursive: true });
    // Build a synthetic log over the 10 MB cap. Each line ~12 KB → 1000 lines ~12 MB.
    const padding = "x".repeat(11900);
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const ts = new Date(Date.now() - (1000 - i) * 1000).toISOString();
      lines.push(JSON.stringify({
        timestamp: ts,
        abstainReason: null,
        top1Score: i,
        top1Top2Ratio: 1.5,
        confidence: "weak",
        marker: `m${i}-${padding}`,
      }));
    }
    writeFileSync(searchLogPath(workspace), lines.join("\n") + "\n");
    expect(statSync(searchLogPath(workspace)).size).toBeGreaterThan(10 * 1024 * 1024);

    const result = rotateSearchLog(workspace);
    expect(result.bytesAfter).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(result.entriesAfter).toBeLessThan(1000);
    // Newest entry (i=999, smallest dateOffset) must survive.
    const remaining = readFileSync(searchLogPath(workspace), "utf-8");
    expect(remaining).toContain("m999-");
  });

  it("drops malformed lines during rotation", () => {
    mkdirSync(join(workspace, ".agent-wiki"), { recursive: true });
    writeFileSync(
      searchLogPath(workspace),
      `{"timestamp":"2026-05-05T00:00:00.000Z","abstainReason":null,"top1Score":1,"top1Top2Ratio":null,"confidence":"weak"}\n`
        + `garbage\n`,
    );
    const result = rotateSearchLog(workspace, new Date("2026-05-06T00:00:00.000Z"));
    expect(result.entriesBefore).toBe(2);
    expect(result.entriesAfter).toBe(1);
  });
});
