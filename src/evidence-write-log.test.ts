import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUnsupportedWriteEvent,
  appendWriteEvent,
  counterLogPath,
  readWriteCounter,
  readWriteLog,
  rotateEventLog,
  summarizeLastWeek,
  writeLogPath,
  evidenceDir,
} from "./evidence-write-log.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "evidence-log-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("appendUnsupportedWriteEvent", () => {
  it("creates the .agent-wiki dir and writes a JSONL line", () => {
    appendUnsupportedWriteEvent(workspace, {
      page: "concept-x.md",
      timestamp: "2026-05-06T10:00:00.000Z",
      hadSynthesisFlag: false,
      rawSourcesCount: 0,
    });
    const path = writeLogPath(workspace);
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.page).toBe("concept-x.md");
  });

  it("appends multiple events as separate lines", () => {
    appendUnsupportedWriteEvent(workspace, {
      page: "a.md", timestamp: "2026-05-06T10:00:00.000Z", hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    appendUnsupportedWriteEvent(workspace, {
      page: "b.md", timestamp: "2026-05-06T10:01:00.000Z", hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    const lines = readFileSync(writeLogPath(workspace), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("does not throw when filesystem write fails", () => {
    // Point at an invalid workspace (nested under a file, not a dir).
    const nonexistent = join(workspace, "not", "a", "real", "path");
    writeFileSync(join(workspace, "not"), "this is a file, not a dir");
    expect(() =>
      appendUnsupportedWriteEvent(nonexistent, {
        page: "x.md", timestamp: "2026-05-06T10:00:00.000Z", hadSynthesisFlag: false, rawSourcesCount: 0,
      })
    ).not.toThrow();
  });
});

describe("readWriteLog", () => {
  it("returns events newer than the 30-day window", () => {
    appendUnsupportedWriteEvent(workspace, {
      page: "recent.md", timestamp: "2026-05-06T10:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    const events = readWriteLog(workspace, new Date("2026-05-07T00:00:00.000Z"));
    expect(events.map((e) => e.page)).toEqual(["recent.md"]);
  });

  it("filters out entries older than 30 days", () => {
    appendUnsupportedWriteEvent(workspace, {
      page: "old.md", timestamp: "2026-01-01T00:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    appendUnsupportedWriteEvent(workspace, {
      page: "new.md", timestamp: "2026-05-05T00:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    const events = readWriteLog(workspace, new Date("2026-05-06T00:00:00.000Z"));
    expect(events.map((e) => e.page)).toEqual(["new.md"]);
  });

  it("skips malformed JSON lines without throwing", () => {
    mkdirSync(evidenceDir(workspace), { recursive: true });
    writeFileSync(
      writeLogPath(workspace),
      `{"page": "ok.md", "timestamp": "2026-05-06T10:00:00.000Z", "hadSynthesisFlag": false, "rawSourcesCount": 0}\nthis is not json\n{"page": "ok2.md", "timestamp": "2026-05-06T11:00:00.000Z", "hadSynthesisFlag": false, "rawSourcesCount": 0}\n`,
    );
    const events = readWriteLog(workspace, new Date("2026-05-07T00:00:00.000Z"));
    expect(events.map((e) => e.page)).toEqual(["ok.md", "ok2.md"]);
  });
});

describe("rotateEventLog", () => {
  it("drops entries older than 30 days", () => {
    appendUnsupportedWriteEvent(workspace, {
      page: "old.md", timestamp: "2025-01-01T00:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    appendUnsupportedWriteEvent(workspace, {
      page: "new.md", timestamp: "2026-05-05T00:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    const result = rotateEventLog(workspace, new Date("2026-05-06T00:00:00.000Z"));
    expect(result.entriesBefore).toBe(2);
    expect(result.entriesAfter).toBe(1);
    const remaining = readFileSync(writeLogPath(workspace), "utf-8");
    expect(remaining).toContain("new.md");
    expect(remaining).not.toContain("old.md");
  });

  it("returns zero counts when no log files exist", () => {
    const result = rotateEventLog(workspace);
    expect(result.entriesBefore).toBe(0);
    expect(result.entriesAfter).toBe(0);
    expect(result.bytesAfter).toBe(0);
    expect(result.unsupported).toEqual({ entriesBefore: 0, entriesAfter: 0, bytesAfter: 0 });
    expect(result.counter).toEqual({ entriesBefore: 0, entriesAfter: 0, bytesAfter: 0 });
  });

  it("drops oldest entries when total exceeds size cap", () => {
    // Synthetic: write a 12 MB log — well over the 10 MB cap.
    mkdirSync(evidenceDir(workspace), { recursive: true });
    const eventLine = (i: number, dateOffsetSec: number) => {
      const ts = new Date(Date.now() - dateOffsetSec * 1000).toISOString();
      // Pad page name so each line is ~12 KB; we'll need ~1000 lines for 12 MB.
      const padding = "x".repeat(11900);
      return JSON.stringify({
        page: `p${i}-${padding}.md`,
        timestamp: ts,
        hadSynthesisFlag: false,
        rawSourcesCount: 0,
      });
    };
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(eventLine(i, 1000 - i)); // older entries first
    }
    writeFileSync(writeLogPath(workspace), lines.join("\n") + "\n");
    expect(statSync(writeLogPath(workspace)).size).toBeGreaterThan(10 * 1024 * 1024);

    const result = rotateEventLog(workspace);
    expect(result.bytesAfter).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(result.entriesAfter).toBeLessThan(1000);
    // Newest entries must be retained — the last one had dateOffsetSec=1.
    const remaining = readFileSync(writeLogPath(workspace), "utf-8");
    expect(remaining).toContain("p999-");
  });
});

describe("summarizeLastWeek", () => {
  it("counts unsupported transitions only within the past 7 days", () => {
    const now = new Date("2026-05-06T00:00:00.000Z");
    appendUnsupportedWriteEvent(workspace, {
      page: "in.md", timestamp: "2026-05-04T00:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    appendUnsupportedWriteEvent(workspace, {
      page: "out.md", timestamp: "2026-04-20T00:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    expect(summarizeLastWeek(workspace, now).unsupportedTransitions).toBe(1);
  });

  it("returns zero counts and null ratio when no log files exist", () => {
    expect(summarizeLastWeek(workspace)).toEqual({
      unsupportedTransitions: 0,
      unsupportedWrites: 0,
      rejectedWrites: 0,
      totalWrites: 0,
      wouldRejectRatio: null,
    });
  });

  it("computes ratio as (unsupported + rejected) / total (mode-invariant)", () => {
    const now = new Date("2026-05-06T00:00:00.000Z");
    // Counter: 5 total — 2 grounded, 1 synthesis, 1 unsupported, 1 rejected.
    // Numerator (would-reject) = unsupported + rejected = 2.
    appendWriteEvent(workspace, "grounded",    "2026-05-04T00:00:00.000Z");
    appendWriteEvent(workspace, "grounded",    "2026-05-04T00:01:00.000Z");
    appendWriteEvent(workspace, "synthesis",   "2026-05-05T00:00:00.000Z");
    appendWriteEvent(workspace, "unsupported", "2026-05-04T00:00:00.000Z");
    appendWriteEvent(workspace, "rejected",    "2026-05-05T01:00:00.000Z");
    const result = summarizeLastWeek(workspace, now);
    expect(result.unsupportedWrites).toBe(1);
    expect(result.rejectedWrites).toBe(1);
    expect(result.totalWrites).toBe(5);
    expect(result.wouldRejectRatio).toBeCloseTo(0.4);
  });

  it("ratio stays meaningful in reject mode (rejectedWrites carries the signal)", () => {
    const now = new Date("2026-05-06T00:00:00.000Z");
    // Phase 2b enabled — wiki.write never produces kind="unsupported";
    // the equivalent writes show up as kind="rejected" instead.
    appendWriteEvent(workspace, "grounded",  "2026-05-04T00:00:00.000Z");
    appendWriteEvent(workspace, "rejected",  "2026-05-04T01:00:00.000Z");
    appendWriteEvent(workspace, "rejected",  "2026-05-04T02:00:00.000Z");
    const result = summarizeLastWeek(workspace, now);
    expect(result.unsupportedWrites).toBe(0);
    expect(result.rejectedWrites).toBe(2);
    expect(result.totalWrites).toBe(3);
    // 2/3 ≈ 0.667 — the ratio still reflects "fraction of writes 2b blocks",
    // even though all unsupported attempts went through the rejected path.
    expect(result.wouldRejectRatio).toBeCloseTo(2 / 3);
  });

  it("reports transitions and unsupportedWrites independently when re-edits inflate the latter", () => {
    const now = new Date("2026-05-06T00:00:00.000Z");
    // 1 transition (page first becomes unsupported), 3 unsupported writes
    // (the transition + 2 re-edits while still unsupported), plus 1 grounded
    // — 4 total writes, 3 of which would be rejected by 2b.
    appendUnsupportedWriteEvent(workspace, {
      page: "p.md", timestamp: "2026-05-04T00:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    appendWriteEvent(workspace, "unsupported", "2026-05-04T00:00:00.000Z");
    appendWriteEvent(workspace, "unsupported", "2026-05-04T01:00:00.000Z");
    appendWriteEvent(workspace, "unsupported", "2026-05-04T02:00:00.000Z");
    appendWriteEvent(workspace, "grounded",    "2026-05-05T00:00:00.000Z");
    const result = summarizeLastWeek(workspace, now);
    expect(result.unsupportedTransitions).toBe(1);
    expect(result.unsupportedWrites).toBe(3);
    expect(result.totalWrites).toBe(4);
    expect(result.wouldRejectRatio).toBeCloseTo(0.75);
  });

  it("excludes counter events outside the 7-day window from the denominator", () => {
    const now = new Date("2026-05-06T00:00:00.000Z");
    appendWriteEvent(workspace, "grounded", "2026-05-04T00:00:00.000Z"); // in
    appendWriteEvent(workspace, "grounded", "2026-04-20T00:00:00.000Z"); // out of 7d (still in 30d)
    const result = summarizeLastWeek(workspace, now);
    expect(result.totalWrites).toBe(1);
    expect(result.wouldRejectRatio).toBe(0);
  });

  it("excludes rejected entries from unsupportedTransitions (Phase 2b log noise)", () => {
    const now = new Date("2026-05-06T00:00:00.000Z");
    // The unsupported log carries TWO event shapes: warn-mode transitions
    // (no `rejected` flag) and reject-mode attempts (`rejected: true`,
    // emitted once per retry). Only the former count as transitions —
    // otherwise a retry loop in reject mode would balloon the count.
    appendUnsupportedWriteEvent(workspace, {
      page: "real-transition.md", timestamp: "2026-05-04T00:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    appendUnsupportedWriteEvent(workspace, {
      page: "blocked.md", timestamp: "2026-05-04T01:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
      rejected: true, rejectReason: "fresh",
    });
    appendUnsupportedWriteEvent(workspace, {
      page: "blocked.md", timestamp: "2026-05-04T01:01:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
      rejected: true, rejectReason: "fresh",
    });
    const result = summarizeLastWeek(workspace, now);
    expect(result.unsupportedTransitions).toBe(1);
  });
});

describe("appendWriteEvent / readWriteCounter", () => {
  it("appends classified writes to the counter file", () => {
    appendWriteEvent(workspace, "grounded", "2026-05-06T10:00:00.000Z");
    appendWriteEvent(workspace, "synthesis", "2026-05-06T10:01:00.000Z");
    appendWriteEvent(workspace, "unsupported", "2026-05-06T10:02:00.000Z");
    appendWriteEvent(workspace, "rejected", "2026-05-06T10:03:00.000Z");
    appendWriteEvent(workspace, "legacy", "2026-05-06T10:04:00.000Z");
    const events = readWriteCounter(workspace, new Date("2026-05-07T00:00:00.000Z"));
    expect(events.map((e) => e.kind)).toEqual([
      "grounded", "synthesis", "unsupported", "rejected", "legacy",
    ]);
  });

  it("filters counter entries older than 30 days on read", () => {
    appendWriteEvent(workspace, "grounded", "2026-01-01T00:00:00.000Z");
    appendWriteEvent(workspace, "grounded", "2026-05-05T00:00:00.000Z");
    const events = readWriteCounter(workspace, new Date("2026-05-06T00:00:00.000Z"));
    expect(events).toHaveLength(1);
  });

  it("does not throw when the counter directory is unwritable", () => {
    const nonexistent = join(workspace, "blocked", "path");
    writeFileSync(join(workspace, "blocked"), "not a dir");
    expect(() =>
      appendWriteEvent(nonexistent, "grounded", "2026-05-06T10:00:00.000Z"),
    ).not.toThrow();
  });
});

describe("rotateEventLog (counter file)", () => {
  it("rotates the counter file alongside the unsupported log", () => {
    appendWriteEvent(workspace, "grounded", "2025-01-01T00:00:00.000Z"); // old
    appendWriteEvent(workspace, "grounded", "2026-05-05T00:00:00.000Z"); // new
    appendUnsupportedWriteEvent(workspace, {
      page: "u.md", timestamp: "2026-05-05T00:00:00.000Z",
      hadSynthesisFlag: false, rawSourcesCount: 0,
    });
    const result = rotateEventLog(workspace, new Date("2026-05-06T00:00:00.000Z"));
    expect(result.counter.entriesBefore).toBe(2);
    expect(result.counter.entriesAfter).toBe(1);
    expect(result.unsupported.entriesAfter).toBe(1);
    const remaining = readFileSync(counterLogPath(workspace), "utf-8");
    expect(remaining).not.toContain("2025-01-01");
    expect(remaining).toContain("2026-05-05");
  });
});
